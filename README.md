# TAKT

🇯🇵 [日本語ドキュメント](./docs/README.ja.md)

**T**ask **A**gent **K**oordination **T**ool - A governance-first orchestrator for running coding agents safely and responsibly

TAKT coordinates AI agents like Claude Code and Codex according to your organization's rules and workflows. It clarifies who is responsible, what is permitted, and how to recover from failures, while automating complex development tasks.

TAKT is built with TAKT itself (dogfooding).

## TAKT is For Teams That Need

- **Want to integrate AI into CI/CD but fear runaway execution** — Clarify control scope with workflow definitions
- **Want automated PR generation but need audit logs** — Record and track all execution history
- **Want to use multiple AI models but manage them uniformly** — Control Claude/Codex/Mock with the same workflow
- **Want to reproduce and debug agent failures** — Maintain complete history with session logs and reports

## What TAKT is NOT

- **Not an autonomous engineer** — TAKT doesn't complete implementations itself; it governs and coordinates multiple agents
- **Not competing with Claude Code Swarm** — While leveraging Swarm's execution power, TAKT provides "operational guardrails" such as workflow definitions, permission controls, and audit logs
- **Not just a workflow engine** — TAKT is designed to address AI-specific challenges (non-determinism, accountability, audit requirements, and reproducibility)

## Requirements

Choose one:

- **Use provider CLIs**: [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or [Codex](https://github.com/openai/codex) installed
- **Use direct API**: **Anthropic API Key** or **OpenAI API Key** (no CLI required)

Additionally required:

- [GitHub CLI](https://cli.github.com/) (`gh`) — Only needed for `takt #N` (GitHub Issue execution)

**Pricing Note**: When using API Keys, TAKT directly calls the Claude API (Anthropic) or OpenAI API. The pricing structure is the same as using Claude Code or Codex. Be mindful of costs, especially when running automated tasks in CI/CD environments, as API usage can accumulate.

## Installation

```bash
npm install -g takt
```

## Quick Start

```bash
# Interactive mode - refine task requirements with AI, then execute
takt

# Execute GitHub Issue as task (both work the same)
takt #6
takt --issue 6

# Pipeline execution (non-interactive, for scripts/CI)
takt --pipeline --task "Fix the bug" --auto-pr
```

## Usage

### Interactive Mode

A mode where you refine task content through conversation with AI before execution. Useful when task requirements are ambiguous or when you want to clarify content while consulting with AI.

```bash
# Start interactive mode (no arguments)
takt

# Specify initial message (short word only)
takt hello
```

**Note:** If you specify a string with spaces, Issue reference (`#6`), or `--task` / `--issue` options, interactive mode will be skipped and the task will be executed directly.

**Flow:**
1. Select workflow
2. Refine task content through conversation with AI
3. Finalize task instructions with `/go` (you can also add additional instructions like `/go additional instructions`)
4. Execute (create worktree, run workflow, create PR)

#### Execution Example

```
$ takt

Select workflow:
  ❯ 🎼 default (current)
    📁 Development/
    📁 Research/
    Cancel

Interactive mode - Enter task content. Commands: /go (execute), /cancel (exit)

> I want to add user authentication feature

[AI confirms and organizes requirements]

> /go

Proposed task instructions:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Implement user authentication feature.

Requirements:
- Login with email address and password
- JWT token-based authentication
- Password hashing (bcrypt)
- Login/logout API endpoints
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Proceed with these task instructions? (Y/n) y

? Create worktree? (Y/n) y

[Workflow execution starts...]
```

### Direct Task Execution

When task content is clear, you can skip interactive mode and execute directly.

```bash
# Specify task content directly (string with spaces)
takt "Add login feature"

# Specify task content with --task option
takt --task "Fix bug"

# Specify workflow
takt "Add authentication" --workflow expert

# Auto-create PR
takt "Fix bug" --auto-pr
```

### GitHub Issue Tasks

You can execute GitHub Issues directly as tasks. Issue title, body, labels, and comments are automatically incorporated as task content.

```bash
# Execute by specifying issue number
takt #6
takt --issue 6

# Issue + workflow specification
takt #6 --workflow expert

# Issue + auto-create PR
takt #6 --auto-pr
```

**Requirements:** [GitHub CLI](https://cli.github.com/) (`gh`) must be installed and authenticated.

### Task Management (add / run / watch / list)

Batch processing using task files (`.takt/tasks/`). Useful for accumulating multiple tasks and executing them together later.

#### Add Task (`takt add`)

```bash
# Refine task requirements through AI conversation, then add task
takt add

# Add task from GitHub Issue (issue number reflected in branch name)
takt add #28
```

#### Execute Tasks (`takt run`)

```bash
# Execute all pending tasks in .takt/tasks/
takt run
```

#### Watch Tasks (`takt watch`)

```bash
# Monitor .takt/tasks/ and auto-execute tasks (resident process)
takt watch
```

#### List Task Branches (`takt list`)

```bash
# List task branches (merge/delete)
takt list
```

### Pipeline Mode (for CI/Automation)

Specifying `--pipeline` enables non-interactive pipeline mode. Automatically creates branch → runs workflow → commits & pushes. Suitable for CI/CD automation.

```bash
# Execute task in pipeline mode
takt --pipeline --task "Fix bug"

# Pipeline execution + auto-create PR
takt --pipeline --task "Fix bug" --auto-pr

# Link issue information
takt --pipeline --issue 99 --auto-pr

# Specify workflow and branch
takt --pipeline --task "Fix bug" -w magi -b feat/fix-bug

# Specify repository (for PR creation)
takt --pipeline --task "Fix bug" --auto-pr --repo owner/repo

# Workflow execution only (skip branch creation, commit, push)
takt --pipeline --task "Fix bug" --skip-git

# Minimal output mode (for CI)
takt --pipeline --task "Fix bug" --quiet
```

In pipeline mode, PRs are not created unless `--auto-pr` is specified.

**GitHub Integration:** When using TAKT in GitHub Actions, see [takt-action](https://github.com/nrslib/takt-action). You can automate PR reviews and task execution. Refer to the [CI/CD Integration](#cicd-integration) section for details.

### Other Commands

```bash
# Interactively switch workflows
takt switch

# Copy builtin workflows/agents to ~/.takt/ for customization
takt eject

# Clear agent conversation sessions
takt clear

# Configure permission mode
takt config
```

### Recommended Workflows

| Workflow | Recommended Use |
|----------|-----------------|
| `default` | Serious development tasks. Used for TAKT's own development. Multi-stage review with parallel reviews (architect + security). |
| `minimal` | Simple fixes and straightforward tasks. Minimal workflow with basic review. |
| `review-fix-minimal` | Review & fix workflow. Specialized for iterative improvement based on review feedback. |
| `research` | Investigation and research. Autonomously executes research without asking questions. |

### Main Options

| Option | Description |
|--------|-------------|
| `--pipeline` | **Enable pipeline (non-interactive) mode** — Required for CI/automation |
| `-t, --task <text>` | Task content (alternative to GitHub Issue) |
| `-i, --issue <N>` | GitHub issue number (same as `#N` in interactive mode) |
| `-w, --workflow <name or path>` | Workflow name or path to workflow YAML file |
| `-b, --branch <name>` | Specify branch name (auto-generated if omitted) |
| `--auto-pr` | Create PR (interactive: skip confirmation, pipeline: enable PR) |
| `--skip-git` | Skip branch creation, commit, and push (pipeline mode, workflow-only) |
| `--repo <owner/repo>` | Specify repository (for PR creation) |
| `--create-worktree <yes\|no>` | Skip worktree confirmation prompt |
| `-q, --quiet` | Minimal output mode: suppress AI output (for CI) |
| `--provider <name>` | Override agent provider (claude\|codex\|mock) |
| `--model <name>` | Override agent model |

## Workflows

TAKT uses YAML-based workflow definitions and rule-based routing. Builtin workflows are embedded in the package, with user workflows in `~/.takt/workflows/` taking priority. Use `takt eject` to copy builtins to `~/.takt/` for customization.

### Workflow Example

```yaml
name: default
max_iterations: 10
initial_step: plan

steps:
  - name: plan
    agent: ../agents/default/planner.md
    model: opus
    edit: false
    rules:
      - condition: Planning complete
        next: implement
    instruction_template: |
      Analyze the request and create an implementation plan.

  - name: implement
    agent: ../agents/default/coder.md
    edit: true
    permission_mode: edit
    rules:
      - condition: Implementation complete
        next: review
      - condition: Blocked
        next: ABORT
    instruction_template: |
      Implement based on the plan.

  - name: review
    agent: ../agents/default/architecture-reviewer.md
    edit: false
    rules:
      - condition: Approved
        next: COMPLETE
      - condition: Needs fix
        next: implement
    instruction_template: |
      Review the implementation from architecture and code quality perspectives.
```

### Agentless Steps

The `agent` field is optional. When omitted, the step executes using only the `instruction_template` without a system prompt. This is useful for simple tasks that don't require agent behavior customization.

```yaml
  - name: summarize
    # No agent specified — uses instruction_template only
    edit: false
    rules:
      - condition: Summary complete
        next: COMPLETE
    instruction_template: |
      Read the report and provide a concise summary.
```

You can also write an inline system prompt as the `agent` value (if the specified file doesn't exist):

```yaml
  - name: review
    agent: "You are a code reviewer. Focus on readability and maintainability."
    edit: false
    instruction_template: |
      Review code quality.
```

### Parallel Steps

Execute sub-steps in parallel within a step and evaluate with aggregate conditions:

```yaml
  - name: reviewers
    parallel:
      - name: arch-review
        agent: ../agents/default/architecture-reviewer.md
        rules:
          - condition: approved
          - condition: needs_fix
        instruction_template: |
          Review architecture and code quality.
      - name: security-review
        agent: ../agents/default/security-reviewer.md
        rules:
          - condition: approved
          - condition: needs_fix
        instruction_template: |
          Review for security vulnerabilities.
    rules:
      - condition: all("approved")
        next: supervise
      - condition: any("needs_fix")
        next: fix
```

- `all("X")`: true if ALL sub-steps matched condition X
- `any("X")`: true if ANY sub-step matched condition X
- Sub-step `rules` define possible outcomes, but `next` is optional (parent controls transition)

### Rule Condition Types

| Type | Syntax | Description |
|------|--------|-------------|
| Tag-based | `"condition text"` | Agent outputs `[STEP:N]` tag, matched by index |
| AI judge | `ai("condition text")` | AI evaluates condition against agent output |
| Aggregate | `all("X")` / `any("X")` | Aggregates parallel sub-step matched conditions |

## Builtin Workflows

TAKT includes multiple builtin workflows:

| Workflow | Description |
|----------|-------------|
| `default` | Full development workflow: plan → architecture design → implement → AI review → parallel review (architect + security) → supervisor approval. Includes fix loops at each review stage. |
| `minimal` | Quick workflow: plan → implement → review → supervisor. Minimal steps for fast iteration. |
| `review-fix-minimal` | Review-focused workflow: review → fix → supervisor. For iterative improvement based on review feedback. |
| `research` | Research workflow: planner → digger → supervisor. Autonomously executes research without asking questions. |
| `expert` | Full-stack development workflow: architecture, frontend, security, QA reviews with fix loops. |
| `expert-cqrs` | Full-stack development workflow (CQRS+ES specialized): CQRS+ES, frontend, security, QA reviews with fix loops. |
| `magi` | Deliberation system inspired by Evangelion. Three AI personas (MELCHIOR, BALTHASAR, CASPER) analyze and vote. |
| `review-only` | Read-only code review workflow that makes no changes. |

Use `takt switch` to switch workflows.

## Builtin Agents

| Agent | Description |
|-------|-------------|
| **planner** | Task analysis, spec investigation, implementation planning |
| **coder** | Feature implementation, bug fixing |
| **ai-antipattern-reviewer** | AI-specific antipattern review (non-existent APIs, incorrect assumptions, scope creep) |
| **architecture-reviewer** | Architecture and code quality review, spec compliance verification |
| **security-reviewer** | Security vulnerability assessment |
| **supervisor** | Final validation, approval |

## Custom Agents

Create agent prompts in Markdown files:

```markdown
# ~/.takt/agents/my-agents/reviewer.md

You are a code reviewer specialized in security.

## Role
- Check for security vulnerabilities
- Verify input validation
- Review authentication logic
```

## Model Selection

The `model` field (in workflow steps, agent config, or global config) is passed directly to the provider (Claude Code CLI / Codex SDK). TAKT does not resolve model aliases.

### Claude Code

Claude Code supports aliases (`opus`, `sonnet`, `haiku`, `opusplan`, `default`) and full model names (e.g., `claude-sonnet-4-5-20250929`). Refer to the [Claude Code documentation](https://docs.anthropic.com/en/docs/claude-code) for available models.

### Codex

The model string is passed to the Codex SDK. If unspecified, defaults to `codex`. Refer to Codex documentation for available models.

## Project Structure

```
~/.takt/                    # Global configuration directory
├── config.yaml             # Global config (provider, model, workflow, etc.)
├── workflows/              # User workflow definitions (override builtins)
│   └── custom.yaml
└── agents/                 # User agent prompt files (.md)
    └── my-agent.md

.takt/                      # Project-level configuration
├── config.yaml             # Project config (current workflow, etc.)
├── tasks/                  # Pending task files (.yaml, .md)
├── completed/              # Completed tasks and reports
├── reports/                # Execution reports (auto-generated)
│   └── {timestamp}-{slug}/
└── logs/                   # NDJSON format session logs
    ├── latest.json         # Pointer to current/latest session
    ├── previous.json       # Pointer to previous session
    └── {sessionId}.jsonl   # NDJSON session log per workflow execution
```

Builtin resources are embedded in the npm package (`dist/resources/`). User files in `~/.takt/` take priority.

### Global Configuration

Configure default provider and model in `~/.takt/config.yaml`:

```yaml
# ~/.takt/config.yaml
language: en
default_workflow: default
log_level: info
provider: claude         # Default provider: claude or codex
model: sonnet            # Default model (optional)

# API Key configuration (optional)
# Can be overridden by environment variables TAKT_ANTHROPIC_API_KEY / TAKT_OPENAI_API_KEY
anthropic_api_key: sk-ant-...  # For Claude (Anthropic)
# openai_api_key: sk-...       # For Codex (OpenAI)

trusted_directories:
  - /path/to/trusted/dir

# Pipeline execution configuration (optional)
# Customize branch names, commit messages, and PR body.
# pipeline:
#   default_branch_prefix: "takt/"
#   commit_message_template: "feat: {title} (#{issue})"
#   pr_body_template: |
#     ## Summary
#     {issue_body}
#     Closes #{issue}
```

**API Key Configuration Methods:**

1. **Set via environment variables**:
   ```bash
   export TAKT_ANTHROPIC_API_KEY=sk-ant-...  # For Claude
   # or
   export TAKT_OPENAI_API_KEY=sk-...         # For Codex
   ```

2. **Set in config file**:
   Write `anthropic_api_key` or `openai_api_key` in `~/.takt/config.yaml` as shown above

Priority: Environment variables > `config.yaml` settings

**Notes:**
- If you set an API Key, installing Claude Code or Codex is not necessary. TAKT directly calls the Anthropic API or OpenAI API.
- **Security**: If you write API Keys in `config.yaml`, be careful not to commit this file to Git. Consider using environment variables or adding `~/.takt/config.yaml` to `.gitignore`.

**Pipeline Template Variables:**

| Variable | Available In | Description |
|----------|-------------|-------------|
| `{title}` | Commit message | Issue title |
| `{issue}` | Commit message, PR body | Issue number |
| `{issue_body}` | PR body | Issue body |
| `{report}` | PR body | Workflow execution report |

**Model Resolution Priority:**
1. Workflow step `model` (highest priority)
2. Custom agent `model`
3. Global config `model`
4. Provider default (Claude: sonnet, Codex: codex)

## Detailed Guides

### Task File Formats

TAKT supports batch processing with task files in `.takt/tasks/`. Both `.yaml`/`.yml` and `.md` file formats are supported.

**YAML format** (recommended, supports worktree/branch/workflow options):

```yaml
# .takt/tasks/add-auth.yaml
task: "Add authentication feature"
worktree: true                  # Execute in isolated shared clone
branch: "feat/add-auth"         # Branch name (auto-generated if omitted)
workflow: "default"             # Workflow specification (uses current if omitted)
```

**Markdown format** (simple, backward compatible):

```markdown
# .takt/tasks/add-login-feature.md

Add login feature to the application.

Requirements:
- Username and password fields
- Form validation
- Error handling on failure
```

#### Isolated Execution with Shared Clone

Specifying `worktree` in YAML task files executes each task in an isolated clone created with `git clone --shared`, keeping your main working directory clean:

- `worktree: true` - Auto-create shared clone in adjacent directory (or location specified by `worktree_dir` config)
- `worktree: "/path/to/dir"` - Create at specified path
- `branch: "feat/xxx"` - Use specified branch (auto-generated as `takt/{timestamp}-{slug}` if omitted)
- Omit `worktree` - Execute in current directory (default)

> **Note**: The YAML field name remains `worktree` for backward compatibility. Internally, it uses `git clone --shared` instead of `git worktree`. Git worktrees have a `.git` file containing `gitdir:` pointing to the main repository, which Claude Code follows to recognize the main repository as the project root. Shared clones have an independent `.git` directory, preventing this issue.

Clones are ephemeral. After task completion, they auto-commit + push, then delete the clone. Branches are the only persistent artifacts. Use `takt list` to list, merge, or delete branches.

### Session Logs

TAKT writes session logs in NDJSON (`.jsonl`) format to `.takt/logs/`. Each record is atomically appended, so partial logs are preserved even if the process crashes, and you can track in real-time with `tail -f`.

- `.takt/logs/latest.json` - Pointer to current (or latest) session
- `.takt/logs/previous.json` - Pointer to previous session
- `.takt/logs/{sessionId}.jsonl` - NDJSON session log per workflow execution

Record types: `workflow_start`, `step_start`, `step_complete`, `workflow_complete`, `workflow_abort`

Agents can read `previous.json` to inherit context from the previous execution. Session continuation is automatic — just run `takt "task"` to continue from the previous session.

### Adding Custom Workflows

Add YAML files to `~/.takt/workflows/` or customize builtins with `takt eject`:

```bash
# Copy default workflow to ~/.takt/workflows/ and edit
takt eject default
```

```yaml
# ~/.takt/workflows/my-workflow.yaml
name: my-workflow
description: Custom workflow
max_iterations: 5
initial_step: analyze

steps:
  - name: analyze
    agent: ~/.takt/agents/my-agents/analyzer.md
    edit: false
    rules:
      - condition: Analysis complete
        next: implement
    instruction_template: |
      Thoroughly analyze this request.

  - name: implement
    agent: ~/.takt/agents/default/coder.md
    edit: true
    permission_mode: edit
    pass_previous_response: true
    rules:
      - condition: Complete
        next: COMPLETE
    instruction_template: |
      Implement based on the analysis.
```

> **Note**: `{task}`, `{previous_response}`, `{user_inputs}` are automatically injected into instructions. Explicit placeholders are only needed if you want to control their position in the template.

### Specifying Agents by Path

In workflow definitions, specify agents using file paths:

```yaml
# Relative path from workflow file
agent: ../agents/default/coder.md

# Home directory
agent: ~/.takt/agents/default/coder.md

# Absolute path
agent: /path/to/custom/agent.md
```

### Workflow Variables

Variables available in `instruction_template`:

| Variable | Description |
|----------|-------------|
| `{task}` | Original user request (auto-injected if not in template) |
| `{iteration}` | Workflow-wide turn count (total steps executed) |
| `{max_iterations}` | Maximum iteration count |
| `{step_iteration}` | Per-step iteration count (times this step has been executed) |
| `{previous_response}` | Output from previous step (auto-injected if not in template) |
| `{user_inputs}` | Additional user inputs during workflow (auto-injected if not in template) |
| `{report_dir}` | Report directory path (e.g., `.takt/reports/20250126-143052-task-summary`) |
| `{report:filename}` | Expands to `{report_dir}/filename` (e.g., `{report:00-plan.md}`) |

### Workflow Design

Elements needed for each workflow step:

**1. Agent** - Markdown file containing system prompt:

```yaml
agent: ../agents/default/coder.md    # Path to agent prompt file
agent_name: coder                    # Display name (optional)
```

**2. Rules** - Define routing from step to next step. The instruction builder auto-injects status output rules, so agents know which tags to output:

```yaml
rules:
  - condition: "Implementation complete"
    next: review
  - condition: "Blocked"
    next: ABORT
```

Special `next` values: `COMPLETE` (success), `ABORT` (failure)

**3. Step Options:**

| Option | Default | Description |
|--------|---------|-------------|
| `edit` | - | Whether step can edit project files (`true`/`false`) |
| `pass_previous_response` | `true` | Pass previous step output to `{previous_response}` |
| `allowed_tools` | - | List of tools agent can use (Read, Glob, Grep, Edit, Write, Bash, etc.) |
| `provider` | - | Override provider for this step (`claude` or `codex`) |
| `model` | - | Override model for this step |
| `permission_mode` | - | Permission mode: `readonly`, `edit`, `full` (provider-independent) |
| `report` | - | Auto-generated report file settings (name, format) |

## API Usage Example

```typescript
import { WorkflowEngine, loadWorkflow } from 'takt';  // npm install takt

const config = loadWorkflow('default');
if (!config) {
  throw new Error('Workflow not found');
}
const engine = new WorkflowEngine(config, process.cwd(), 'My task');

engine.on('step:complete', (step, response) => {
  console.log(`${step.name}: ${response.status}`);
});

await engine.run();
```

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md) for details.

## CI/CD Integration

### GitHub Actions

TAKT provides a GitHub Action for automating PR reviews and task execution. See [takt-action](https://github.com/nrslib/takt-action) for details.

**Workflow example** (see [.github/workflows/takt-action.yml](../.github/workflows/takt-action.yml) in this repository):

```yaml
name: TAKT

on:
  issue_comment:
    types: [created]

jobs:
  takt:
    if: contains(github.event.comment.body, '@takt')
    runs-on: ubuntu-latest
    permissions:
      contents: write
      issues: write
      pull-requests: write

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Run TAKT
        uses: nrslib/takt-action@main
        with:
          anthropic_api_key: ${{ secrets.TAKT_ANTHROPIC_API_KEY }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

**Cost Warning**: TAKT uses AI APIs (Claude or OpenAI), which can incur significant costs, especially when tasks are auto-executed in CI/CD environments. Monitor API usage and set up billing alerts.

### Other CI Systems

For CI systems other than GitHub, use pipeline mode:

```bash
# Install takt
npm install -g takt

# Run in pipeline mode
takt --pipeline --task "Fix bug" --auto-pr --repo owner/repo
```

For authentication, set `TAKT_ANTHROPIC_API_KEY` or `TAKT_OPENAI_API_KEY` environment variables (TAKT-specific prefix).

```bash
# For Claude (Anthropic)
export TAKT_ANTHROPIC_API_KEY=sk-ant-...

# For Codex (OpenAI)
export TAKT_OPENAI_API_KEY=sk-...
```

## Documentation

- [Workflow Guide](./docs/workflows.md) - Creating and customizing workflows
- [Agent Guide](./docs/agents.md) - Configuring custom agents
- [Changelog](../CHANGELOG.md) - Version history
- [Security Policy](../SECURITY.md) - Vulnerability reporting
- [Blog: TAKT - AI Agent Orchestration](https://zenn.dev/nrs/articles/c6842288a526d7) - Design philosophy and practical usage guide (Japanese)

## License

MIT - See [LICENSE](../LICENSE) for details.
