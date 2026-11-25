#!/usr/bin/env python3
"""notify_orca.py を、TAKT の task_finish_hook と同じ環境変数・偽の orca・偽の run で確かめる。

使い方:
    python3 .takt/scripts/notify_orca_test.py

確かめる観点:
  1. 指示文の `orca: bot=<名前> item=<番号>` の行から宛先と項目番号を決め、orca へ
     --from takt-workflow --to bot:<名前> --type status --subject --body-file --json --item を渡す。
     本文にはプロジェクト・ゴール ID・タスク・workKey・issue・PR・結果・実行 ID・run の
     ディレクトリ・ブランチ・項目番号が入る。送れたら orca が返したメッセージ ID を記録する。
  2. 指示文に行が無いときは、設定の map が指す対応表の `<ゴール ID>:<タスク名>` から
     宛先・項目・issue・PR を決める。
  3. どちらにも無いときは設定（<プロジェクト>/.takt/notify-orca.json）の default_bot 宛てにし、
     --item を付けず、項目番号を「不明」と書く。形の崩れた `orca:` 行は使わない。設定も無ければ送らない。
  3a. issue の欄と Orca の項目番号を取り違えない（指示文に両方がある・issue の URL だけ・
      `orca:` 行だけの 3 通り）。
  4. TAKT_FINISH_STATUS と中断の記録から終わり方を決める（完了・失敗・中断・PR 失敗・工程の上限）。
     ワークフローの ABORT（Workflow aborted by step transition）、ゴールの中止・一時停止
     （Goal <ID> was aborted / paused）、停止（INTERRUPTED=true）は中断。
     完了以外では、終わった工程（meta.json の failure.step、無ければログの最後の step_complete）と
     TAKT の失敗の理由（1 行、長さを制限、認証情報らしい値は伏せる）を書く。知らない状態は送らない。
  4a. tasks.yaml のエントリは名前で引き、名前で一つに絞れないときは run slug で絞る。
  5. run のディレクトリが無いときは、tasks.yaml の task_dir の order.md から宛先を読み、
     <プロジェクト>/.takt/notify-orca.log に記録する。
  6. orca が失敗・時間切れ・存在しない・引数が不正なときも終了コード 0 で終わり、1 行残す。
     orca の標準エラーは本文にも記録にも貼らず、notify-orca.stderr に分けて残す。
     時間切れでは orca の子プロセスも止める。
  7. TAKT と同じく HOME などを渡さない最小の環境で、プロジェクトルートを作業ディレクトリにして動く。
  8. このリポジトリの設定: .takt/notify-orca.json の default_bot が設定されている。
     .takt/config.yaml の task_finish_hook がこのスクリプトを呼び、その timeout_ms は orca の
     打ち切りより長い。.takt/workflows の各ワークフローには通知の工程が無い（成功の通知が二重にならない）。

実の orca は呼ばない。すべて一時ディレクトリで完結する。
"""
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import traceback
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "notify_orca.py"
TAKT_DIR = SCRIPT.parent.parent
SLUG = "20261124-100000-sample-task-abcdef"
GOAL = "9a930940-7d84-47a2-b7cc-0377f0640094"
TEST_TIMEOUT_SECONDS = 30

FAKE_ORCA = """#!/bin/sh
out="{out}"
: > "$out.args"
prev=""
for arg in "$@"; do
  printf '%s\\n' "$arg" >> "$out.args"
  if [ "$prev" = "--body-file" ]; then cat "$arg" > "$out.body"; fi
  prev="$arg"
done
{tail}
"""
SENT = "echo '{\"ok\":true,\"result\":{\"message\":{\"id\":\"msg_abc123\"}}}'; exit 0"


class TestTimeout(Exception):
    pass


def _on_timeout(signum, frame):
    raise TestTimeout()


class Workspace:
    """偽のプロジェクト、作業用クローン、run ディレクトリ、偽の orca を持つ一時ディレクトリ。"""

    def __init__(self, order, orca_tail=SENT, meta=None):
        self.base = Path(tempfile.mkdtemp(prefix="notify-orca-test-")).resolve()
        self.project = self.base / "takt"
        self.clone = self.base / "takt-worktrees" / "20261124T1000-sample-task"
        self.run = self.clone / ".takt" / "runs" / SLUG
        (self.run / "context" / "task").mkdir(parents=True)
        (self.run / "context" / "task" / "order.md").write_text(order, encoding="utf-8")
        (self.run / "meta.json").write_text(
            json.dumps(meta or {"runSlug": SLUG, "workflow": "sample-workflow", "status": "completed"}),
            encoding="utf-8",
        )
        self.task_dir = self.project / ".takt" / "tasks" / SLUG
        self.task_dir.mkdir(parents=True)
        (self.task_dir / "order.md").write_text(order, encoding="utf-8")
        (self.project / ".takt" / "tasks.yaml").write_text(
            "tasks:\n"
            "  - name: other-task\n"
            "    status: completed\n"
            f"  - goal_id: {GOAL}\n"
            "    goal_work_key: sample-work-key\n"
            "    name: sample-task\n"
            "    status: completed\n"
            f"    run_slug: {SLUG}\n"
            "    execution_id: 11111111-2222-3333-4444-555555555555\n"
            f"    task_dir: .takt/tasks/{SLUG}\n"
            f"    worktree_path: {self.clone}\n"
            "    workflow: sample-workflow\n",
            encoding="utf-8",
        )
        self.map = self.base / "takt-orca-map.json"
        self.config = self.project / ".takt" / "notify-orca.json"
        self.config.write_text(
            json.dumps({"default_bot": "default-bot", "map": str(self.map)}, ensure_ascii=False),
            encoding="utf-8",
        )
        self.out = self.base / "orca-call"
        self.orca = self.base / "fake-orca"
        self.write_orca(orca_tail)

    def write_orca(self, tail):
        self.orca.write_text(FAKE_ORCA.format(out=self.out, tail=tail), encoding="utf-8")
        self.orca.chmod(0o755)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        shutil.rmtree(self.base, ignore_errors=True)
        return False

    def finish_env(self, status="completed", **extra):
        """TAKT の task_finish_hook が渡すのと同じ形の環境変数。"""
        env = {
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "TMPDIR": str(self.base),
            "TAKT_FINISH_TASK_NAME": "sample-task",
            "TAKT_FINISH_STATUS": status,
            "TAKT_FINISH_PROJECT_DIR": str(self.project),
            "TAKT_FINISH_INTERRUPTED": "false",
            "TAKT_FINISH_COMPLETED_AT": "2026-11-24T10:10:00.000Z",
            "TAKT_FINISH_RUN_SLUG": SLUG,
            "TAKT_FINISH_RUN_DIR": str(self.run),
            "TAKT_FINISH_BRANCH": "takt/sample-task",
            "TAKT_FINISH_WORKTREE_PATH": str(self.clone),
            "TAKT_FINISH_GOAL_ID": GOAL,
        }
        env.update(extra)
        return {key: value for key, value in env.items() if value is not None}

    def run_script(self, *args, env=None, orca=None, timeout="5"):
        command = [sys.executable, str(SCRIPT), *args,
                   "--orca", str(orca or self.orca), "--timeout", timeout]
        started = time.monotonic()
        completed = subprocess.run(
            command, cwd=self.project, env=env or self.finish_env(),
            capture_output=True, text=True, timeout=25,
        )
        return completed, time.monotonic() - started

    def args(self):
        return self.out.with_suffix(".args").read_text(encoding="utf-8").splitlines()

    def body(self):
        return self.out.with_suffix(".body").read_text(encoding="utf-8")

    def log(self, directory=None):
        return ((directory or self.run) / "notify-orca.log").read_text(encoding="utf-8")


def option(args, name):
    assert name in args, f"{name} が orca の引数にありません: {args}"
    return args[args.index(name) + 1]


def test_order_line_routes_to_bot_and_item() -> None:
    order = "issue #93 の修正。\nPR https://github.com/j5ik2o/takt/pull/341\norca: bot=ops-bot item=149\n"
    with Workspace(order) as ws:
        env = ws.finish_env(TAKT_FINISH_PR_URL="https://github.com/j5ik2o/takt/pull/350")
        completed, _ = ws.run_script(env=env)
        assert completed.returncode == 0, completed
        args = ws.args()
        assert args[:2] == ["orchestration", "send"], args
        assert option(args, "--from") == "takt-workflow"
        assert option(args, "--to") == "bot:ops-bot"
        assert option(args, "--type") == "status"
        assert option(args, "--subject") == "TAKT 完了: sample-task"
        assert option(args, "--item") == "149"
        assert "--json" in args, args
        body = ws.body()
        for expected in (
            f"プロジェクト: {ws.project}",
            f"ゴール ID: {GOAL}",
            "タスク: sample-task（workKey: sample-work-key）",
            "issue: 93",
            "PR: https://github.com/j5ik2o/takt/pull/341, https://github.com/j5ik2o/takt/pull/350",
            "結果: 完了（TAKT の状態: completed、中断の記録: なし）",
            "ワークフロー: sample-workflow",
            f"実行 ID: 11111111-2222-3333-4444-555555555555（run: {SLUG}）",
            f"run のディレクトリ: {ws.run}",
            "ブランチ: takt/sample-task",
            f"指示文: {ws.run / 'context' / 'task' / 'order.md'}",
            "Orca の項目番号: 149（宛先の決め方: 指示文）",
        ):
            assert expected in body, f"本文に {expected!r} がありません:\n{body}"
        assert "理由:" not in body
        assert "送信した（msg_abc123）: bot:ops-bot item=149" in ws.log()
        assert len(completed.stdout.splitlines()) == 1, completed.stdout


def test_map_routes_when_order_has_no_line() -> None:
    with Workspace("指示文に宛先の行は無い。\n") as ws:
        ws.map.write_text(json.dumps({
            f"{GOAL}:sample-task": {
                "item": 134, "bot": "default-bot", "issues": [93, 94],
                "pr": "https://github.com/j5ik2o/takt/pull/341",
            },
        }), encoding="utf-8")
        completed, _ = ws.run_script()
        assert completed.returncode == 0
        args = ws.args()
        assert option(args, "--to") == "bot:default-bot"
        assert option(args, "--item") == "134"
        body = ws.body()
        assert "issue: #93, #94" in body, body
        assert "PR: https://github.com/j5ik2o/takt/pull/341" in body, body
        assert "Orca の項目番号: 134（宛先の決め方: 対応表）" in body, body


def test_default_route_without_line_or_map() -> None:
    with Workspace("orca: bot=ops-bot item=abc\norca: bot=\"x y\" item=3\n") as ws:
        completed, _ = ws.run_script()
        assert completed.returncode == 0
        args = ws.args()
        assert option(args, "--to") == "bot:default-bot"
        assert "--item" not in args, args
        assert "Orca の項目番号: 不明（宛先の決め方: 既定）" in ws.body()


FAILED_META = {
    "runSlug": SLUG, "workflow": "sample-workflow", "status": "failed",
    "failure": {"step": "machine_gate", "error": "x"},
}


def test_finish_kinds_set_subject_and_reason() -> None:
    cases = {
        "失敗": ({"TAKT_FINISH_STATUS": "failed", "TAKT_FINISH_FAILURE_REASON": "rule_no_match"},
                 "TAKT 失敗: sample-task", "（TAKT の状態: failed、中断の記録: なし）",
                 "理由: 工程 sample-workflow/machine_gate のあと失敗で終わった（TAKT の記録: rule_no_match）"),
        "ワークフローの ABORT": (
            {"TAKT_FINISH_STATUS": "failed", "TAKT_FINISH_FAILURE_REASON": "Workflow aborted by step transition"},
            "TAKT 中断: sample-task", "（TAKT の状態: failed、中断の記録: なし）",
            "理由: 工程 sample-workflow/machine_gate のあと中断で終わった"
            "（TAKT の記録: Workflow aborted by step transition）"),
        "停止": ({"TAKT_FINISH_STATUS": "failed", "TAKT_FINISH_INTERRUPTED": "true",
                  "TAKT_FINISH_FAILURE_REASON": "Task stopped"},
                 "TAKT 中断: sample-task", "（TAKT の状態: failed、中断の記録: あり）",
                 "のあと中断で終わった（TAKT の記録: Task stopped）"),
        "ゴールの中止": ({"TAKT_FINISH_STATUS": "failed", "TAKT_FINISH_FAILURE_REASON": f"Goal {GOAL} was aborted"},
                         "TAKT 中断: sample-task", "（TAKT の状態: failed、中断の記録: なし）",
                         f"のあと中断で終わった（TAKT の記録: Goal {GOAL} was aborted）"),
        "ゴールの一時停止": ({"TAKT_FINISH_STATUS": "failed", "TAKT_FINISH_INTERRUPTED": "true",
                              "TAKT_FINISH_FAILURE_REASON": f"Goal {GOAL} was paused"},
                             "TAKT 中断: sample-task", "（TAKT の状態: failed、中断の記録: あり）",
                             f"のあと中断で終わった（TAKT の記録: Goal {GOAL} was paused）"),
        "文言が完全には一致しない": (
            {"TAKT_FINISH_STATUS": "failed", "TAKT_FINISH_FAILURE_REASON": "Step x failed: Goal y was aborted later"},
            "TAKT 失敗: sample-task", "（TAKT の状態: failed、", "のあと失敗で終わった"),
        "PR 失敗": ({"TAKT_FINISH_STATUS": "pr_failed", "TAKT_FINISH_FAILURE_REASON": "gh pr create failed"},
                    "TAKT PR 失敗: sample-task", "（TAKT の状態: pr_failed、",
                    "のあとPR 失敗で終わった（TAKT の記録: gh pr create failed）"),
        "工程の上限": ({"TAKT_FINISH_STATUS": "exceeded"},
                       "TAKT 工程の上限: sample-task", "（TAKT の状態: exceeded、",
                       "理由: 工程 sample-workflow/machine_gate のあと工程の上限で終わった\n"),
    }
    for label, (extra, subject, state, reason) in cases.items():
        with Workspace("orca: bot=default-bot item=238\n", meta=FAILED_META) as ws:
            completed, _ = ws.run_script(env=ws.finish_env(**extra))
            assert completed.returncode == 0, label
            assert option(ws.args(), "--subject") == subject, (label, ws.args())
            body = ws.body()
            assert state in body, (label, body)
            assert reason in body, (label, body)


def test_failure_reason_is_one_short_line() -> None:
    reason = "Step \"develop\" failed:\n" + "x" * 1000
    with Workspace("orca: bot=default-bot item=238\n", meta=FAILED_META) as ws:
        completed, _ = ws.run_script(env=ws.finish_env("failed", TAKT_FINISH_FAILURE_REASON=reason))
        assert completed.returncode == 0
        line = next(line for line in ws.body().splitlines() if line.startswith("- 理由:"))
        assert "Step \"develop\" failed: xxx" in line, line
        assert line.endswith("…）") and len(line) < 400, line


def test_failure_reason_hides_credentials() -> None:
    token = "ghp_" + "a" * 36
    reason = (f"gh failed: Authorization: Bearer abc.def.ghi; GH_TOKEN={token} "
              "api_key=sk-" + "b" * 30 + " password=\"hunter2\" token limit exceeded")
    with Workspace("orca: bot=default-bot item=238\n", meta=FAILED_META) as ws:
        completed, _ = ws.run_script(env=ws.finish_env("failed", TAKT_FINISH_FAILURE_REASON=reason))
        assert completed.returncode == 0
        body = ws.body()
        for secret in ("abc.def.ghi", token, "sk-bbbb", "hunter2"):
            assert secret not in body, (secret, body)
        assert "Authorization: Bearer ***" in body, body
        assert "token limit exceeded" in body, body


def test_reason_step_comes_from_run_log_without_failure_step() -> None:
    with Workspace("orca: bot=ops-bot item=149\n") as ws:
        logs = ws.run / "logs"
        logs.mkdir()
        order = ["machine_gate", "fix_machine_gate_fmt", "machine_gate", "fix_machine_gate_clippy",
                 "machine_gate", "fix_machine_gate_fmt"]
        records = [{"type": "step_start", "step": "x", "workflow": "sample-workflow"}]
        records += [{"type": "step_complete", "step": step, "workflow": "sample-workflow"} for step in order]
        (logs / "20261124-100000-abcdef.jsonl").write_text(
            "\n".join(json.dumps(record) for record in records) + "\nnot json\n", encoding="utf-8"
        )
        completed, _ = ws.run_script(env=ws.finish_env("failed"))
        assert completed.returncode == 0
        assert "理由: 工程 sample-workflow/fix_machine_gate_fmt のあと失敗で終わった\n" in ws.body(), ws.body()


def test_unknown_status_is_not_sent() -> None:
    for status in ("running", None):
        with Workspace("orca: bot=ops-bot item=149\n") as ws:
            completed, _ = ws.run_script(env=ws.finish_env(status))
            assert completed.returncode == 0, status
            assert not ws.out.with_suffix(".args").exists(), f"{status} なのに orca を呼びました"
            assert "終わり方が分からないので送らなかった" in ws.log(ws.project / ".takt"), status


ISSUE_URL = "https://github.com/j5ik2o/takt/issues/93"


def test_issue_and_item_are_not_confused() -> None:
    cases = {
        "両方": (f"対象 {ISSUE_URL}\norca: bot=ops-bot item=149\n", ISSUE_URL, "149", "bot:ops-bot"),
        "issue の URL だけ": (f"対象 {ISSUE_URL}\n", ISSUE_URL, None, "bot:default-bot"),
        "orca: 行だけ": ("宛先だけ書く。\norca: bot=ops-bot item=149\n", "なし", "149", "bot:ops-bot"),
    }
    for label, (order, issue, item, to) in cases.items():
        with Workspace(order) as ws:
            completed, _ = ws.run_script()
            assert completed.returncode == 0, label
            args, body = ws.args(), ws.body()
            assert option(args, "--to") == to, (label, args)
            assert f"- issue: {issue}\n" in body, (label, body)
            if item is None:
                assert "--item" not in args, (label, args)
                assert "Orca の項目番号: 不明" in body, (label, body)
            else:
                assert option(args, "--item") == item, (label, args)
                assert f"Orca の項目番号: {item}（" in body, (label, body)
            assert "issue: 149" not in body, (label, body)


def test_order_from_task_dir_when_run_dir_is_gone() -> None:
    with Workspace("orca: bot=ops-bot item=149\n") as ws:
        shutil.rmtree(ws.clone)
        completed, _ = ws.run_script(env=ws.finish_env("failed", TAKT_FINISH_RUN_DIR=None))
        assert completed.returncode == 0
        assert option(ws.args(), "--item") == "149"
        body = ws.body()
        assert f"指示文: {ws.task_dir / 'order.md'}" in body, body
        assert "run のディレクトリ: 不明" in body, body
        assert "理由: 工程 不明 のあと失敗で終わった" in body, body
        assert "送信した" in ws.log(ws.project / ".takt")


def test_entry_is_narrowed_by_run_slug_when_name_is_not_unique() -> None:
    stale = (
        "  - name: sample-task\n"
        "    goal_work_key: stale-work-key\n"
        "    status: failed\n"
        "    run_slug: 20261101-000000-sample-task-old\n"
    )
    for label, edit in {
        "同じ名前が 2 件": lambda text: text + stale,
        "名前が違う": lambda text: text.replace("    name: sample-task\n", "    name: renamed-task\n"),
    }.items():
        with Workspace("orca: bot=default-bot item=238\n") as ws:
            tasks = ws.project / ".takt" / "tasks.yaml"
            tasks.write_text(edit(tasks.read_text(encoding="utf-8")), encoding="utf-8")
            completed, _ = ws.run_script()
            assert completed.returncode == 0, label
            assert "（workKey: sample-work-key）" in ws.body(), (label, ws.body())


def test_without_destination_nothing_is_sent() -> None:
    with Workspace("宛先の行は無い。\n") as ws:
        ws.config.unlink()
        completed, _ = ws.run_script()
        assert completed.returncode == 0
        assert not ws.out.with_suffix(".args").exists(), "宛先が無いのに orca を呼びました"
        assert "どれにも無いので送らなかった" in ws.log()


def test_orca_failure_still_exits_zero() -> None:
    with Workspace("orca: bot=ops-bot item=149\n", orca_tail="echo boom >&2; exit 3") as ws:
        completed, _ = ws.run_script()
        assert completed.returncode == 0
        assert f"orca が終了コード 3 で失敗した（標準エラー: {ws.run / 'notify-orca.stderr'}）" in ws.log()
        assert "boom" not in ws.log() and "boom" not in completed.stdout
        assert (ws.run / "notify-orca.stderr").read_text(encoding="utf-8") == "boom\n"


def test_orca_timeout_is_cut_and_child_stopped() -> None:
    with Workspace("orca: bot=ops-bot item=149\n") as ws:
        pidfile = ws.base / "child.pid"
        ws.write_orca(f'sleep 30 & echo $! > "{pidfile}"; wait')
        completed, elapsed = ws.run_script(timeout="3")
        assert completed.returncode == 0
        assert elapsed < 15, f"時間切れで打ち切られていません: {elapsed:.1f}s"
        assert "orca が 3 秒で終わらず打ち切った" in ws.log()
        assert pidfile.exists(), "偽の orca が子プロセスを起こす前に打ち切られました"
        child = int(pidfile.read_text().strip())
        time.sleep(0.2)
        # 孤児を回収しない環境では止まった子がゾンビ（状態 Z）として残るため、状態で判定する。
        state = subprocess.run(
            ["ps", "-o", "stat=", "-p", str(child)], capture_output=True, text=True
        ).stdout.strip()
        if state and not state.startswith("Z"):
            os.kill(child, signal.SIGKILL)
            raise AssertionError(f"orca の子プロセスが動いたまま残っています（状態 {state}）")


def test_missing_orca_still_exits_zero() -> None:
    with Workspace("orca: bot=ops-bot item=149\n") as ws:
        completed, _ = ws.run_script(orca=ws.base / "no-such-orca")
        assert completed.returncode == 0
        assert "orca を起動できない" in ws.log()


def test_invalid_argument_still_exits_zero() -> None:
    with Workspace("orca: bot=ops-bot item=149\n") as ws:
        completed, _ = ws.run_script("--no-such-option")
        assert completed.returncode == 0
        assert not ws.out.with_suffix(".args").exists(), "引数が不正なのに orca を呼びました"
        assert "引数が不正" in ws.log(ws.project / ".takt")


def test_repository_has_default_bot() -> None:
    config = json.loads((TAKT_DIR / "notify-orca.json").read_text(encoding="utf-8"))
    bot = config.get("default_bot")
    assert isinstance(bot, str) and re.fullmatch(r"[^\s\"'`$\\]{1,64}", bot), config


def test_project_finish_hook_calls_this_script() -> None:
    text = (TAKT_DIR / "config.yaml").read_text(encoding="utf-8")
    block = re.search(r"^task_finish_hook:\n((?:  .*\n)+)", text, re.MULTILINE)
    assert block, "config.yaml に task_finish_hook がありません"
    assert "  command: [python3, .takt/scripts/notify_orca.py]\n" in block.group(1), block.group(1)
    timeout = re.search(r"^  timeout_ms: (\d+)$", block.group(1), re.MULTILINE)
    # orca の打ち切り（既定 10 秒）とスクリプトの起動に余裕を残し、TAKT 側の打ち切りより先に終わる。
    assert timeout and int(timeout.group(1)) >= 12000, block.group(1)


def test_workflows_have_no_notify_step() -> None:
    # 成功の通知は task_finish_hook だけが送る。ワークフローの工程からも送ると二重になる。
    workflows = sorted((TAKT_DIR / "workflows").glob("*.yaml"))
    assert workflows, "ワークフローが見つかりません"
    for path in workflows:
        text = path.read_text(encoding="utf-8")
        assert "notify_orca" not in text, path.name
        assert "notify_completed" not in text, path.name


def main() -> int:
    tests = [
        test_order_line_routes_to_bot_and_item,
        test_map_routes_when_order_has_no_line,
        test_default_route_without_line_or_map,
        test_finish_kinds_set_subject_and_reason,
        test_failure_reason_is_one_short_line,
        test_failure_reason_hides_credentials,
        test_reason_step_comes_from_run_log_without_failure_step,
        test_unknown_status_is_not_sent,
        test_issue_and_item_are_not_confused,
        test_order_from_task_dir_when_run_dir_is_gone,
        test_entry_is_narrowed_by_run_slug_when_name_is_not_unique,
        test_without_destination_nothing_is_sent,
        test_orca_failure_still_exits_zero,
        test_orca_timeout_is_cut_and_child_stopped,
        test_missing_orca_still_exits_zero,
        test_invalid_argument_still_exits_zero,
        test_repository_has_default_bot,
        test_project_finish_hook_calls_this_script,
        test_workflows_have_no_notify_step,
    ]
    failures = 0
    for test in tests:
        signal.signal(signal.SIGALRM, _on_timeout)
        signal.alarm(TEST_TIMEOUT_SECONDS)
        try:
            test()
        except AssertionError as error:
            failures += 1
            print(f"FAIL {test.__name__}: {error}")
        except TestTimeout:
            failures += 1
            print(f"FAIL {test.__name__}: did not finish within {TEST_TIMEOUT_SECONDS}s")
        except Exception:
            failures += 1
            print(f"FAIL {test.__name__}:")
            traceback.print_exc()
        else:
            print(f"ok   {test.__name__}")
        finally:
            signal.alarm(0)
    print(f"{len(tests) - failures} passed, {failures} failed")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
