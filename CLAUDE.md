<!-- GSD:project-start source:PROJECT.md -->
## Project

**Telegram-бот «Незаменимые»**

Telegram-бот для закрытого подписочного сообщества «Клуб Незаменимых» — среды для профессионалов, строящих персональные AI-системы из агентов. MVP — ежедневный новостной дайджест «AI-радар»: бот парсит 9 RSS-источников, фильтрует через LLM и публикует 3–5 самых значимых новостей в тред Telegram-группы клуба.

**Core Value:** Участники клуба получают качественно отфильтрованный AI-дайджест каждое утро — это создаёт привычку заходить в клуб и экономит 30–60 минут ежедневного скроллинга.

### Constraints

- **Стек**: Node.js 20+, Grammy, TypeScript, node-cron, pino, rss-parser — зафиксировано в спеке
- **Деплой**: VPS + Docker, long-polling (не webhooks)
- **LLM**: абстракция ai.service.ts — поддержка Claude API и OpenAI API, переключение через .env
- **Типизация**: строгий TypeScript, никаких `any`
- **Модульность**: каждая функция = модуль в `modules/`, plug-and-play архитектура для будущих расширений
- **Тон бота**: «штурман → пилот», прямой, без восторгов — как разведка докладывает штабу
<!-- GSD:project-end -->

<!-- GSD:stack-start source:STACK.md -->
## Technology Stack

Technology stack not yet documented. Will populate after codebase mapping or first phase.
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->
## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, or `.github/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
