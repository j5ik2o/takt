#!/usr/bin/env python3
"""TAKT のタスクの終わりを、Orca の担当ボットへ `orca orchestration send` で知らせる。

使い方（プロジェクトの .takt/config.yaml の task_finish_hook から呼ぶ）:
    task_finish_hook:
      command: [python3, .takt/scripts/notify_orca.py]

TAKT はキューのタスクの最終状態を .takt/tasks.yaml に保存した後、プロジェクトルートを
作業ディレクトリにしてこのコマンドを 1 回呼ぶ。終わり方と run・タスク・ゴールの情報は
環境変数 TAKT_FINISH_* で受け取る。

終わり方（件名と本文の「結果」）:
  completed                        完了
  failed（中断の記録あり、            中断（停止、ゴールの中止・一時停止、ワークフローの ABORT。
    ワークフローが ABORT へ進んだ、         ただし Caccia の失敗理由で ABORT 文言が置き換わった
    ゴールの中止・一時停止）                場合や SIGINT で中断の記録が無い場合は「失敗」）
  failed（それ以外）               失敗
  pr_failed                        PR 失敗
  exceeded                         工程の上限
質問待ちは最終状態ではないため、この出口では扱わない（台帳の見張りが扱う）。

宛先の決め方（先に見つかったものを使う）。宛先はその TAKT の仕事を管理しているボットにする:
  1. タスクの指示文（order.md）の 1 行 `orca: bot=<ボット名> item=<番号>`。投入したボットが
     自分の名前と項目番号を書く。ただし GitHub Issue / PR 本文から作られた指示文では無視し、
     ボット名も設定で許可されたもの（default_bot と allowed_bots）に限る。
  2. 設定の map が指す対応表の `<ゴール ID>:<タスク名>` または `<ゴール ID>:<workKey>` のエントリ
  3. 設定の default_bot（そのプロジェクトを担当するボット）、項目番号「不明」
  どれも無ければ送らずに記録だけ残す。

設定（プロジェクトごとに 1 か所）:
  .takt/notify-orca.json に {"default_bot": "<担当ボット>", "allowed_bots": ["<許可ボット>"], "map": "<対応表のパス>"}
  を置く。allowed_bots と map は省略でき、~ はホームに展開する。ほかのプロジェクトへ写すときは
  この設定だけを変える。

壊さない:
  どんな失敗でも終了コード 0 で終わる（TAKT は終了コードで状態も再開位置も変えないが、
  警告も出さないようにする）。orca の呼び出しは --timeout 秒（既定 10。task_finish_hook の
  timeout_ms より短くする）で打ち切る。結果は 1 行だけを run のディレクトリの notify-orca.log
  （run が無ければ <プロジェクト>/.takt/notify-orca.log）に追記し、標準出力にも 1 行だけ出す。
  orca の標準エラーは同じ場所の notify-orca.stderr に先頭 4 KiB だけ残す（本文と記録には貼らない）。
"""
from __future__ import annotations

import argparse
import contextlib
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_ORCA = "/Applications/Orca.app/Contents/Resources/bin/orca"
CONFIG_NAME = "notify-orca.json"
# Orca の端末の外（TAKT の出口）から送るため、送信元の名前を --from で明示する。
# 無いと orca は no_active_sender_terminal で送らない。
DEFAULT_SENDER = "takt-workflow"
UNKNOWN_ITEM = "不明"
LOG_NAME = "notify-orca.log"
STDERR_NAME = "notify-orca.stderr"
STDERR_LIMIT = 4096
REASON_LIMIT = 300
# 中断として扱う失敗の理由。TAKT は中断の種類（abortKind）を出口に渡さないため、保存する
# 文言で見分ける: ワークフローの工程が ABORT へ進んだとき、ゴールの中止・一時停止で
# 失敗にしたとき（待ちのタスクは中断の記録なしで保存される）。なお、Caccia の失敗理由で
# ABORT 文言が置き換わった場合はここには一致せず「失敗」として届く。
ABORT_REASON = re.compile(r"Workflow aborted by step transition|Goal \S+ was (?:aborted|paused)")
# 失敗の理由を本文へ入れる前に伏せる、認証情報らしい値。
SECRET = re.compile(
    r"(?i)(\b(?:token|access[_-]?token|authorization|password|passwd|secret|api[_-]?key)[\"']?\s*[:=]\s*[\"']?"
    r"(?:bearer\s+|basic\s+)?|\bbearer\s+)[^\s,;'\"]+"
    r"|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abpr]-[A-Za-z0-9-]{10,})"
)
ORCA_LINE = re.compile(r"^\s*orca:\s*bot=(\S+)\s+item=([1-9][0-9]*)\s*$", re.MULTILINE)
GITHUB_ORDER_HEADER = re.compile(r"^\s*##\s+(?:Issue\s+#\d+:|PR\s+#\d+\s+Review\s+Comments:)")
POSITIVE_INT = re.compile(r"[1-9][0-9]*")
BOT_NAME = re.compile(r"^[^\s\"'`$\\]{1,64}$")
PR_URL = re.compile(r"https://github\.com/[^/\s]+/[^/\s]+/pull/\d+")
MESSAGE_ID = re.compile(r"\bmsg_[0-9A-Za-z]+\b")


# TAKT_FINISH_STATUS ごとの終わり方。failed は中断かどうかで分ける。
FINISH_LABELS = {"completed": "完了", "pr_failed": "PR 失敗", "exceeded": "工程の上限", "failed": "失敗"}


def finish_label(environ) -> str | None:
    """TAKT_FINISH_STATUS と中断の記録から、件名に使う終わり方を返す。知らない状態なら None。"""
    label = FINISH_LABELS.get(environ.get("TAKT_FINISH_STATUS") or "")
    aborted = (
        environ.get("TAKT_FINISH_INTERRUPTED") == "true"
        or ABORT_REASON.fullmatch(environ.get("TAKT_FINISH_FAILURE_REASON") or "") is not None
    )
    return "中断" if label == "失敗" and aborted else label


def read_config(explicit, project: Path) -> dict:
    """notify-orca.json を読み、default_bot・allowed_bots・map（Path か None）を返す。読めなければ空。"""
    path = Path(explicit) if explicit else project / ".takt" / CONFIG_NAME
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = None
    if not isinstance(data, dict):
        return {"default_bot": None, "allowed_bots": frozenset(), "map": None}
    bot = data.get("default_bot")
    default_bot = bot if isinstance(bot, str) and BOT_NAME.fullmatch(bot) else None
    allowed = set()
    if default_bot is not None:
        allowed.add(default_bot)
    raw_allowed = data.get("allowed_bots")
    if isinstance(raw_allowed, list):
        for candidate in raw_allowed:
            if isinstance(candidate, str) and BOT_NAME.fullmatch(candidate):
                allowed.add(candidate)
    table = data.get("map")
    return {
        "default_bot": default_bot,
        "allowed_bots": frozenset(allowed),
        # TAKT は HOME を渡さないが、expanduser はパスワードデータベースへ倒れる。
        "map": Path(os.path.expanduser(table)) if isinstance(table, str) and table else None,
    }


ISSUE_URL = re.compile(r"https://github\.com/[^/\s]+/[^/\s]+/issues/\d+", re.IGNORECASE)
# 番号の直後が数字、または数字が続くピリオド（小数・バージョン表記の続き）のときは
# issue 番号として扱わない。
ISSUE_NUMBER = re.compile(r"issue\s*#?\s*(\d+)(?!\d|\.\d)", re.IGNORECASE)
BLOCK_SCALAR_INDICATORS = (">", ">-", ">+", "|", "|-", "|+")


def extract_issue_reference(text: str) -> str | None:
    """指示文から issue の参照を取り出す。issue の URL を優先し、無ければ `issue #N` の番号。"""
    match = ISSUE_URL.search(text)
    if match is not None:
        return match.group(0)
    match = ISSUE_NUMBER.search(text)
    return match.group(1) if match is not None else None


def _clean_value(raw: str) -> str:
    text = raw.strip()
    if text in ("", "~", "null", "Null", "NULL"):
        return ""
    if len(text) >= 2 and text[0] == text[-1] and text[0] in ("'", '"'):
        return text[1:-1]
    return text


def _indent_of(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def parse_tasks_yaml(path: Path) -> list:
    """tasks.yaml の tasks 配列を、キーと値の辞書のリストとして読む。

    PyYAML に依存しない最小の読み取り。各エントリは `- key: value` で始まり、続く行は
    同じエントリの直下のキーだけを読む（ネストしたマップや `retry_note: >-` などの
    ブロックスカラーの本文は読み飛ばす）。読めなければ例外を投げる（呼び出し側が空として扱う）。
    """
    entries: list = []
    current = None
    entry_indent = None
    field_indent = None
    block_indent = None
    for line in path.read_text(encoding="utf-8").splitlines():
        if block_indent is not None:
            if not line.strip() or _indent_of(line) > block_indent:
                continue
            block_indent = None
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or stripped == "tasks:":
            continue
        indent = _indent_of(line)
        if stripped.startswith("- ") and (entry_indent is None or indent == entry_indent):
            if current is not None:
                entries.append(current)
            if entry_indent is None:
                entry_indent = indent
            current = {}
            after_dash = stripped[2:]
            field_indent = indent + 2 + (len(after_dash) - len(after_dash.lstrip(" ")))
            body = after_dash.lstrip(" ")
        elif current is not None and field_indent is not None and indent == field_indent:
            body = stripped
        else:
            continue
        if ":" not in body:
            continue
        key, _, value = body.partition(":")
        current[key.strip().strip("'\"")] = _clean_value(value)
        if value.strip() in BLOCK_SCALAR_INDICATORS:
            block_indent = indent
    if current is not None:
        entries.append(current)
    return entries


def find_entry(project: Path, task_name: str, run_slug: str) -> dict:
    """プロジェクトの tasks.yaml から、このタスクのエントリを返す。一つに絞れなければ空。

    TAKT は出口へ渡すタスクを名前で引くので、名前で照合する。名前で一つに絞れないとき
    （台帳を手で直したなど）は、run slug で絞る。
    """
    if not (task_name or run_slug):
        return {}
    try:
        entries = parse_tasks_yaml(project / ".takt" / "tasks.yaml")
    except Exception:
        return {}
    by_name = [entry for entry in entries if task_name and entry.get("name") == task_name]
    if len(by_name) == 1:
        return by_name[0]
    by_slug = [entry for entry in (by_name or entries) if run_slug and entry.get("run_slug") == run_slug]
    if len(by_slug) == 1:
        return by_slug[0]
    return {}


def read_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def last_step(run_dir: Path | None) -> str | None:
    """終わった工程を「ワークフロー名/工程名」で返す。

    meta.json の failure.step（失敗した工程）を先に使い、無ければ run の logs/*.jsonl の
    最後の step_complete を使う。
    """
    if run_dir is None:
        return None
    meta = read_json(run_dir / "meta.json")
    failure = meta.get("failure")
    if isinstance(failure, dict) and isinstance(failure.get("step"), str):
        workflow = meta.get("workflow")
        return f"{workflow}/{failure['step']}" if isinstance(workflow, str) else failure["step"]
    last = None
    for log in sorted((run_dir / "logs").glob("*.jsonl")):
        try:
            lines = log.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for line in lines:
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if isinstance(record, dict) and record.get("type") == "step_complete":
                step, workflow = record.get("step"), record.get("workflow")
                if isinstance(step, str):
                    last = f"{workflow}/{step}" if isinstance(workflow, str) else step
    return last


def read_order(run_dir: Path | None, project: Path, entry: dict) -> tuple[str, Path | None]:
    candidates = []
    if run_dir is not None:
        candidates.append(run_dir / "context" / "task" / "order.md")
    if entry.get("task_dir"):
        candidates.append(project / entry["task_dir"] / "order.md")
    for path in candidates:
        try:
            return path.read_text(encoding="utf-8", errors="replace"), path
        except OSError:
            continue
    return "", None


def is_github_sourced_order(entry: dict, order: str) -> bool:
    """GitHub の Issue / PR 本文やコメントがそのまま入る指示文かどうか。"""
    if entry.get("source") in ("issue", "pr_review"):
        return True
    return GITHUB_ORDER_HEADER.match(order) is not None


def route_from_order(order: str, allowed_bots: frozenset[str]):
    if not allowed_bots:
        return None
    for match in ORCA_LINE.finditer(order):
        bot, item = match.group(1), match.group(2)
        if BOT_NAME.fullmatch(bot) and bot in allowed_bots:
            return bot, item, "指示文"
    return None


def route_from_map(map_path: Path, goal_id: str, refs):
    if not goal_id:
        return None
    table = read_json(map_path)
    for ref in refs:
        route = table.get(f"{goal_id}:{ref}") if ref else None
        if not isinstance(route, dict):
            continue
        bot, item = route.get("bot"), route.get("item")
        if isinstance(bot, str) and BOT_NAME.fullmatch(bot) and type(item) is int and item > 0:
            return bot, str(item), "対応表", route
    return None


def redact(text: str) -> str:
    return SECRET.sub(lambda m: f"{m.group(1)}***" if m.group(1) else "***", text)


def one_line(text: str, limit: int = REASON_LIMIT) -> str:
    first = " ".join(redact(text).split())
    return first if len(first) <= limit else first[: limit - 1] + "…"


def build_message(args, environ, label: str) -> dict:
    project = Path(environ.get("TAKT_FINISH_PROJECT_DIR") or Path.cwd())
    task_name = environ.get("TAKT_FINISH_TASK_NAME") or ""
    run_slug = environ.get("TAKT_FINISH_RUN_SLUG") or ""
    run_dir_value = environ.get("TAKT_FINISH_RUN_DIR")
    run_dir = Path(run_dir_value) if run_dir_value and Path(run_dir_value).is_dir() else None
    entry = find_entry(project, task_name, run_slug)
    order, order_path = read_order(run_dir, project, entry)

    goal_id = environ.get("TAKT_FINISH_GOAL_ID") or entry.get("goal_id", "")
    work_key = entry.get("goal_work_key", "")
    config = read_config(args.config, project)

    # 台帳に保存された issue / pr_number を優先し、無い場合だけ指示文から補完する。
    entry_issue = entry.get("issue") or ""
    if POSITIVE_INT.fullmatch(entry_issue):
        issue_suffix = f"/issues/{entry_issue}"
        matched_issue_url = next(
            (url for url in ISSUE_URL.findall(order) if url.lower().endswith(issue_suffix)),
            None,
        )
        issue = matched_issue_url or f"#{entry_issue}"
    elif order:
        # 宛先の行（item=<番号>）を issue と取り違えないよう、その行を除いて読む。
        issue = extract_issue_reference(ORCA_LINE.sub("", order))
    else:
        issue = None

    prs: set[str] = set()
    finish_pr_url = environ.get("TAKT_FINISH_PR_URL") or ""
    if PR_URL.fullmatch(finish_pr_url):
        prs.add(finish_pr_url)
    entry_pr = entry.get("pr_number") or entry.get("context_pr_number") or ""
    if POSITIVE_INT.fullmatch(entry_pr):
        pr_suffix = f"/pull/{entry_pr}"
        if not any(url.lower().endswith(pr_suffix) for url in prs):
            matched_pr_url = next(
                (url for url in PR_URL.findall(order) if url.lower().endswith(pr_suffix)),
                None,
            )
            prs.add(matched_pr_url or f"#{entry_pr}")
    else:
        prs.update(PR_URL.findall(order))

    route = None if is_github_sourced_order(entry, order) else route_from_order(order, config["allowed_bots"])
    map_route = None
    if route is None and config["map"] is not None:
        found = route_from_map(config["map"], goal_id, (task_name, work_key))
        if found is not None:
            route, map_route = found[:3], found[3]
    if route is None and config["default_bot"] is not None:
        route = (config["default_bot"], UNKNOWN_ITEM, "既定")
    bot, item, route_source = route if route is not None else (None, UNKNOWN_ITEM, "なし")
    if map_route is not None:
        if not issue and map_route.get("issues"):
            issue = ", ".join(f"#{number}" for number in map_route["issues"])
        if isinstance(map_route.get("pr"), str) and PR_URL.fullmatch(map_route["pr"]):
            if POSITIVE_INT.fullmatch(entry_pr) and map_route["pr"].lower().endswith(f"/pull/{entry_pr}"):
                prs.discard(f"#{entry_pr}")
            prs.add(map_route["pr"])

    status = environ.get("TAKT_FINISH_STATUS")
    interrupted = "あり" if environ.get("TAKT_FINISH_INTERRUPTED") == "true" else "なし"
    lines = [
        f"TAKT の実行が終わりました: {label}",
        f"- プロジェクト: {project}",
        f"- ゴール ID: {goal_id or 'なし'}",
        f"- タスク: {task_name or '不明'}（workKey: {work_key or 'なし'}）",
        f"- issue: {issue or 'なし'}",
        f"- PR: {', '.join(sorted(prs)) if prs else 'なし'}",
        f"- 結果: {label}（TAKT の状態: {status}、中断の記録: {interrupted}）",
    ]
    if status != "completed":
        reason = f"工程 {last_step(run_dir) or '不明'} のあと{label}で終わった"
        failure = environ.get("TAKT_FINISH_FAILURE_REASON")
        if failure:
            reason += f"（TAKT の記録: {one_line(failure)}）"
        lines.append(f"- 理由: {reason}")
    workflow = read_json(run_dir / "meta.json").get("workflow") if run_dir else None
    lines += [
        f"- ワークフロー: {workflow or entry.get('workflow') or '不明'}",
        f"- 実行 ID: {entry.get('execution_id') or '不明'}（run: {run_slug or '不明'}）",
        f"- run のディレクトリ: {run_dir or '不明'}",
        f"- ブランチ: {environ.get('TAKT_FINISH_BRANCH') or 'なし'}",
        f"- 指示文: {order_path or '不明'}",
        f"- Orca の項目番号: {item}（宛先の決め方: {route_source}）",
    ]
    return {
        "bot": bot,
        "item": item,
        "subject": f"TAKT {label}: {task_name or run_slug or '不明'}",
        "body": "\n".join(lines) + "\n",
        "log_dir": run_dir if run_dir is not None else project / ".takt",
    }


def send(orca: str, message: dict, timeout: float, sender: str = DEFAULT_SENDER) -> str:
    """orca を呼び、結果の 1 行の要約を返す。例外は投げない。

    orca の標準エラーは log_dir の notify-orca.stderr に残し（先頭 4 KiB まで）、要約にはパスだけを書く。
    送れたときは orca が返したメッセージ ID を要約に入れる。
    """
    body_path = None
    stderr_path = message["log_dir"] / STDERR_NAME
    try:
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", prefix="notify-orca-", suffix=".md", delete=False
        ) as handle:
            handle.write(message["body"])
            body_path = handle.name
        command = [
            orca, "orchestration", "send",
            "--from", sender,
            "--to", f"bot:{message['bot']}",
            "--type", "status",
            "--subject", message["subject"],
            "--body-file", body_path,
            "--json",
        ]
        if message["item"] != UNKNOWN_ITEM:
            command += ["--item", message["item"]]
        stderr_path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
            try:
                process = subprocess.Popen(
                    command,
                    stdin=subprocess.DEVNULL,
                    stdout=stdout,
                    stderr=stderr,
                    start_new_session=True,
                )
            except OSError as error:
                return f"orca を起動できない（{type(error).__name__}）"
            try:
                code = process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGKILL)
                process.wait()
                code = None
            stderr.seek(0)
            stderr_path.write_bytes(stderr.read(STDERR_LIMIT))
            stdout.seek(0)
            sent_id = MESSAGE_ID.search(stdout.read(STDERR_LIMIT).decode("utf-8", "replace"))
        if code is None:
            return f"orca が {timeout:g} 秒で終わらず打ち切った（標準エラー: {stderr_path}）"
        if code != 0:
            return f"orca が終了コード {code} で失敗した（標準エラー: {stderr_path}）"
        return f"送信した（{sent_id.group(0)}）" if sent_id else "送信した"
    except Exception as error:
        return f"送信の準備に失敗した（{type(error).__name__}）"
    finally:
        if body_path is not None:
            Path(body_path).unlink(missing_ok=True)


def record(log_dir: Path, line: str) -> str:
    """1 行を記録し、標準出力へ出す 1 行を返す。記録できなければその旨を足す。"""
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
        with (log_dir / LOG_NAME).open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except OSError as error:
        return f"{line}（記録に失敗した: {type(error).__name__}）"
    return line


def main(argv=None, environ=None) -> int:
    environ = os.environ if environ is None else environ
    log_dir = Path(environ.get("TAKT_FINISH_PROJECT_DIR") or Path.cwd()) / ".takt"
    try:
        parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
        parser.add_argument("--orca", default=DEFAULT_ORCA)
        parser.add_argument("--config", help=f"既定は <プロジェクト>/.takt/{CONFIG_NAME}")
        parser.add_argument("--timeout", type=float, default=10.0)
        parser.add_argument("--sender", default=DEFAULT_SENDER)
        try:
            args = parser.parse_args(argv)
        except SystemExit:
            print(record(log_dir, f"{_now()} notify-orca: 引数が不正なので送らなかった"))
            return 0
        label = finish_label(environ)
        if label is None:
            status = environ.get("TAKT_FINISH_STATUS") or "なし"
            line = f"{_now()} notify-orca: TAKT_FINISH_STATUS が {status} で終わり方が分からないので送らなかった"
            print(record(log_dir, line))
            return 0
        message = build_message(args, environ, label)
        log_dir = message["log_dir"]
        if message["bot"] is None:
            outcome = f"宛先が指示文・対応表・設定（{CONFIG_NAME} の default_bot）のどれにも無いので送らなかった"
        else:
            outcome = send(args.orca, message, args.timeout, args.sender)
        line = (
            f"{_now()} notify-orca: {outcome}: bot:{message['bot']} item={message['item']} "
            f"件名「{message['subject']}」"
        )
    except BaseException as error:  # 通知の失敗で TAKT の判定を変えない
        line = f"{_now()} notify-orca: 想定外の失敗（{type(error).__name__}）"
    print(record(log_dir, line))
    return 0


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


if __name__ == "__main__":
    sys.exit(main())
