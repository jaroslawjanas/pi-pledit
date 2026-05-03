# pi-pledit

Permission modes for **[Pi](https://github.com/badlogic/pi-mono)** — inspired by Claude Code's plan/execute workflow.

Cycle between **Plan**, **Accept Edits**, and **Default** modes to control how aggressively the agent modifies your codebase.

---

## ✨ Features

- **∥∥ Plan Mode** — Read-only. The model analyzes your code and produces a structured implementation plan saved to `.pi/plans/`.
- **⏵⏵ Accept Edits** — Auto-approves file edits and safe filesystem commands. Fast execution without interruption.
- **Default** — Prompts before every file edit or shell command. Full manual control.
- **Persistent** — Mode survives session resume, reload, and restarts.
- **Approval workflow** — After a plan completes, a dialog lets you choose: auto-execute, manual review, or keep planning.

---

## 📦 Installation

### As a Pi Package (recommended)

```bash
pi install git:github.com/<your-username>/pi-pledit
```

Or add to your Pi `settings.json`:

```json
{
  "packages": ["git:github.com/<your-username>/pi-pledit"]
}
```

### Manual (single file)

Copy `index.ts` to `~/.pi/agent/extensions/plan-edits-mode.ts`.

### Project-local

Copy `index.ts` to `.pi/extensions/plan-edits-mode.ts` in your project.

---

## 🚀 Usage

Press your configured shortcut to cycle modes:

| Current | Press shortcut → | Next |
|---------|------------------|------|
| Default | → | Accept Edits |
| Accept Edits | → | Plan |
| Plan | → | Default |

Default shortcut: **`F6`**

The current mode appears in the status bar:
- **(blank)** — Default mode
- **`∥∥ plan mode`** — Plan mode
- **`⏵⏵ accept edits`** — Accept edits mode

### After a plan completes

When you finish a plan, a dialog appears:

```
The plan is ready to execute. Would you like to proceed?

  1. Auto-accept edits
  2. Manually approve edits
  3. Provide further feedback
```

| Choice | Result |
|--------|--------|
| **Auto-accept edits** | Switches to Accept Edits mode and executes the plan |
| **Manually approve edits** | Switches to Default mode and asks before each change |
| **Provide further feedback** | Stays in Plan mode; type your feedback and continue |

---

## ⚙️ Configuration

### Custom Shortcut

Create `.pi/pledit.json` in your project (or `~/.pi/agent/pledit.json` globally):

```json
{ "shortcut": "shift+tab" }
```

Precedence: project config > global config > default (`F6`).

After editing, run `/reload` in Pi to apply.

### Rebinding Pi's Thinking Level Cycle

If you set your pleedit shortcut to `shift+tab`, Pi's built-in thinking-level cycle (`app.thinking.cycle`) will be displaced. Move it to another key in `~/.pi/agent/keybindings.json`:

```json
{
  "app.thinking.cycle": ["alt+e"]
}
```

### Customizing Bash Command Safety

You can override which bash commands are allowed in each mode via `.pi/pledit.json`:

```json
{
  "shortcut": "f6",
  "readonlyBash": [
    "git status", "git log", "ls ", "find ", "grep ", "cat ", "echo ", "pwd "
  ],
  "safeBash": [
    "mkdir ", "touch ", "mv ", "cp ", "npm run ", "cargo test"
  ],
  "unsafePatterns": [
    "rm -rf", "sudo", "docker system prune"
  ]
}
```

| Key | Purpose |
|-----|---------|
| `readonlyBash` | Commands **allowed in all modes** without prompting (Plan, Default, Accept Edits). |
| `safeBash` | Commands **auto-approved only in Accept Edits mode**. Prompted in Default mode. Blocked in Plan mode. |
| `unsafePatterns` | Substrings that **block or prompt everywhere** — overrides both lists above. |

**Important:** These lists **replace** the built-in defaults entirely, they do not extend them. If you provide `safeBash: ["cargo test"]`, you must also include `mkdir`, `touch`, etc. if you want them.

Default `unsafePatterns`: `rm -rf`, `sudo`, `chmod 777`, `docker system prune`.

---

## 🛡️ Modes in Detail

### Plan Mode (`∥∥ plan mode`)

- **Blocked:** `write`, `edit`
- **Allowed bash (read-only):** `git status`, `git diff`, `git log`, `git branch`, `git stash list`, `git show`, `ls`, `find`, `grep`, `rg`, `cat`, `head`, `tail`, `echo`, `pwd`, `which`, `wc`
- **Blocked bash:** everything else (`mkdir`, `touch`, `mv`, `npm run`, etc.)
- **Allowed tools:** `read`, `glob`, `grep`, `find`, `ls` — all read-only tools
- The model is instructed to produce a structured plan as its final response
- Plans are saved to `.pi/plans/plan-YYYY-MM-DDTHH-mm-ss.md` with YAML frontmatter

### Accept Edits Mode (`⏵⏵ accept edits`)

- **Auto-approved:** `write`, `edit`
- **Auto-approved bash (safe):** `mkdir`, `touch`, `mv`, `cp`, `rm`, `rmdir`, `sed`, `npm test`, `npm run *`, `yarn *`, `pnpm *`
- **Also auto-approved:** all read-only bash commands listed above
- **Prompted:** anything not in the safe or read-only lists, or matching an `unsafePatterns` substring (e.g. `sudo`, `rm -rf`)

### Default Mode

- **Prompted:** Every `write`, `edit`, and non-readonly `bash` call
- **Allowed silently:** Read-only bash commands (same list as Plan mode)
- Full manual control over destructive changes

---

## 📝 Plan Files

When a plan completes, the model's last text response is saved to:

```
.pi/plans/plan-2026-05-03T21-45-00.md
```

With YAML frontmatter:

```markdown
---
created: "2026-05-03T21:45:00.000Z"
mode: "plan"
session: "/path/to/session.jsonl"
---

# Plan

[Model-generated structured plan...]
```

These files are ephemeral working notes — useful for review, not committed.

---

## 📄 License

MIT
