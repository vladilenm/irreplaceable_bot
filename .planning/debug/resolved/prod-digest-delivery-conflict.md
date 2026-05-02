---
status: resolved
trigger: "prod-digest-delivery-conflict — Digest message sent to Telegram + Telegram sendMessage failed after retry; bot.start() failed повторяется; Privacy mode OFF дублируется; команды админа не отвечают; thread-summary шлёт пустое; повторный /digest заблокирован"
created: 2026-05-02T00:00:00Z
updated: 2026-05-02T00:00:00Z
---

## Current Focus

hypothesis: Двойной long-polling-инстанс → Telegram отдаёт 409 Conflict на getUpdates → grammy rethrows → bot.start() rejects → process.exit(1) → restart loop. Параллельно три более мелких бага путают чтение лога: (а) лог "Digest message sent to Telegram" пишется не только digest sender'ом, но и thread-summary sender'ом через общий sendMessageWithRetry — поэтому success-строка появляется ПОСЛЕ digest failure и относится к thread-summary; (б) summarizeThread при llm-error возвращает skipped:true, а formatter всё равно строит "header + 'тихо: N из N'" пустой пост, и sender его шлёт; (в) idempotency-флаг lastDigestDate пишется ДО фактической отправки в digest pipeline (в runDigestPipeline), поэтому повторный /digest получает isDigestPublishedToday()=true даже после failed sendMessage.
test: прочитаны все ключевые файлы; каждое утверждение подкреплено file:line evidence
expecting: смотри Resolution
next_action: вернуть структурированный root cause report пользователю; ничего не править (find_root_cause_only)

## Symptoms

expected:
- /digest → бот публикует AI-радар в указанный thread группы
- thread-summary cron → бот публикует непустую сводку или skip-сообщение «нет сообщений»
- админские команды (/digest, /status, /start) выполняются и возвращают ответ
- success-лог «Digest message sent to Telegram» соответствует реальной доставке

actual:
- логи говорят «Digest message sent to Telegram», но в чате ничего нет
- параллельно «Telegram sendMessage failed, retrying in 3s» → «Telegram sendMessage failed after retry» → «Cron job handler failed»
- thread-summary: «summarizeThread: LLM call failed», но всё равно «Thread-summary chunk sent»
- админ вызывает /digest несколько раз — лог «/digest command received» есть, ответа в чате нет
- «bot.start() failed» встречается несколько раз
- «Privacy mode OFF, bot will receive group messages» дублируется в одном запуске (×2)

errors: см. порядок строк в objective

reproduction:
- Прод-окружение Timeweb App Platform, docker-compose. Воспроизводится при каждом cron-цикле и при ручном /digest.
- Локально по словам пользователя работает.

started: 2026-05-02. Релизы fa0be68 и 7906c66 от 2026-05-01 (copy config/ + prompts/ в прод-образ; env-block для Timeweb sanitizer).

## Eliminated

- hypothesis: «Идemпотент-флаг ставится перед фактической отправкой и поэтому /digest второй раз не идёт» как ОСНОВНАЯ причина
  evidence: косвенно опровергнуто — даже если флаг не успевал бы ставиться, всё равно бот не может отвечать на команды (см. Hypothesis 1). Но это РЕАЛЬНЫЙ соп-баг, см. Evidence #6.
  timestamp: 2026-05-02

## Evidence

- timestamp: 2026-05-02
  checked: src/utils/preflight.ts:34 ("Privacy mode OFF, bot will receive group messages") и src/index.ts:26-32 (`bot.start({ onStart: () => { ...; void runPreflight(bot) } })`)
  found: `runPreflight` вызывается ровно один раз из `onStart` callback'а grammy. Grammy 1.42 (node_modules/grammy/out/bot.js:295) дёргает `onStart` один раз на каждый успешный `start()`. Внутри grammy НЕТ повторного `onStart` после ретраев polling.
  implication: появление `Privacy mode OFF, bot will receive group messages` ДВАЖДЫ в одном «startup-окне» лога (между двумя `Starting bot...`) физически возможно только если ДВА процесса/контейнера с одним и тем же BOT_TOKEN параллельно запустили bot.start, и их stdout слились в один лог-стрим Timeweb. Это ЯВНЫЙ сигнал двойного инстанса.

- timestamp: 2026-05-02
  checked: node_modules/grammy/out/bot.js:443-447 (`handlePollingError`)
  found: Grammy 1.42 при ошибке polling от Telegram: для error_code 401 или 409 — `throw error` (rethrows). Только 429 ретраится, остальные → throw.
  implication: 409 Conflict (когда два long-polling-клиента с одним токеном бьются за getUpdates) пробрасывается из `bot.start()` промиса. В src/index.ts:33-36 это попадает в `.catch(...)` → `logger.fatal(... 'bot.start() failed')` → `process.exit(1)`. docker-compose.yml:4 `restart: unless-stopped` поднимает контейнер заново. Так формируется restart loop, в котором каждый рестарт пишет «Starting bot... → Database initialised → Cron job registered (×3) → Tracking whitelist loaded → Scheduler started → Bot is running (long-polling mode) → ...» и через несколько секунд снова «bot.start() failed». Полностью совпадает с порядком строк, который пользователь привёл.

- timestamp: 2026-05-02
  checked: src/utils/telegram.ts:26-48 (`sendMessageWithRetry`) и src/modules/thread-summary/thread-summary.sender.ts:1-31 (`sendThreadSummary` импортирует ту же `sendMessageWithRetry`)
  found: `sendMessageWithRetry` пишет лог «Digest message sent to Telegram» (telegram.ts:31) при УСПЕХЕ как для digest, так и для thread-summary — она используется обоими senders (digest.sender.ts:3-4, thread-summary.sender.ts:4). У лога нет поля «kind» / «pipeline», только chatId+threadId. На fail после ретрая пишется «Telegram sendMessage failed after retry» (telegram.ts:44) и пробрасывается throw.
  implication: в логах пользователя порядок строк после digest-failure такой:
    `Telegram sendMessage failed after retry` (digest_send упал)
    `Cron job handler failed` (digestHandler в cron.ts:48 поймал throw из sendDigest)
    `Cron triggered` (новый тик — thread-summary cron)
    `Starting thread-summary pipeline`
    `summarizeThread: LLM call failed`
    `Thread-summary pipeline complete`
    `Digest message sent to Telegram`     ← это thread-summary chunk shipped through the SAME sendMessageWithRetry, обманчиво называется "Digest"
    `Thread-summary chunk sent`
    `Cron: thread-summary cycle complete`
  То есть «Digest message sent to Telegram» в этой пачке — НЕ digest. Это thread-summary chunk. Misleading log message, но НЕ ложный success — он действительно сообщает, что Telegram принял sendMessage. То, что пользователь не видит сообщения в группе — артефакт другого механизма (см. Evidence #5).

- timestamp: 2026-05-02
  checked: src/modules/thread-summary/thread-summary.service.ts:135-146 (per-thread try/catch + push skipped:true) и src/services/summarizer.service.ts:241-246 (LLM error → return skipped:true, reason:'llm-error', НЕ throw)
  found: при ЛЮБОЙ LLM-ошибке summarizer не бросает — возвращает `{skipped:true, reason:'llm-error'}`. Orchestrator складывает все skipped в массив `summaries`. Если ВСЕ треды получили llm-error, `nonSkipped.length === 0`.
  implication: все треды просуммаризировались как skipped — пайплайн НЕ падает.

- timestamp: 2026-05-02
  checked: src/modules/thread-summary/thread-summary.formatter.ts:138-141 (empty-digest case D-35 — все skipped → header + footer "тихо: N из N") и thread-summary.sender.ts:17-30 (sender отправляет непустой chunk)
  found: при всех skipped formatter возвращает массив из ОДНОГО chunk вида `<b>🧵 Сводки тредов · 02.05.2026</b>\n\nтихо: N из N`. Это НЕ пустая строка, поэтому `chunk === ''` guard на sender'е (thread-summary.sender.ts:19) не сработает — sendMessageWithRetry зовётся, в Telegram уходит «технический» пост «тихо: N из N» БЕЗ ВСЯКОЙ ПРЕДУПРЕДИТЕЛЬНОЙ СЕМАНТИКИ о том, что LLM упал на ВСЕХ тредах. С точки зрения пользователя «бот опубликовал что-то пустое».
  implication: «summarizeThread: LLM call failed» → «Thread-summary chunk sent» — это работа по дизайну (D-35 empty-digest path), но архитектура НЕ различает «пусто потому что в тредах не было сообщений / низкий volume» от «пусто потому что у LLM API сегодня outage». Маскирует системный сбой под нормальный «тихий день».

- timestamp: 2026-05-02
  checked: src/modules/digest/digest.service.ts:108-117 (`if (persistState) { writeState({lastDigestDate: new Date().toISOString(), lastSkipped: skipped, lastItemCount: itemCount}) }`) и src/bot.ts:73-76 (`if (isDigestPublishedToday()) { ctx.reply('уже опубликован сегодня'); return }`)
  found: state.json пишется ВНУТРИ runDigestPipeline ПОСЛЕ AI filtering и ДО `sendDigest`. То есть `lastDigestDate` ставится РАНЬШЕ, чем sendMessageWithRetry дёргает Telegram. Если sendMessage упал — флаг всё равно обновлён. На следующий /digest от админа `isDigestPublishedToday()` вернёт true и бот ответит «Дайджест уже опубликован сегодня».
  implication: даже если бы инстансы не дрались, после первого failed-send digest-у НЕ дадут переотправиться через /digest без прямой правки data/state.json. Idempotency-флаг и фактическая доставка decoupled — ставится по факту «pipeline отработал», а не «Telegram принял сообщение». Это РЕАЛЬНЫЙ баг, отдельный от корневой 409-проблемы.

- timestamp: 2026-05-02
  checked: src/bot.ts:63-112 (`/digest`), :115-161 (`/status`), :49-60 (`/start`)
  found: команды зарегистрированы ДО `registerCaptureHandlers(bot)` (bot.ts:221), `bot.catch` стоит первым (bot.ts:15). Order корректный. Однако сами команды могут логировать «/digest command received» только если update_id ДОШЁЛ до этого процесса.
  implication: если процесс А держит активную polling-сессию (выиграл getUpdates-гонку у процесса Б) — апдейты идут в А; В ВИДИМОЙ части лога это выглядит как «/digest command received» БЕЗ ответа: процесс А упал на следующем тике (409 от Telegram пришёл когда Б всё-таки удалось встрять), команда уже залогирована, но `await ctx.reply(...)` или `await sendDigest(...)` упали в момент рестарта. На второй попытке /digest после успешного ребута флаг lastDigestDate уже стоит → процесс отвечает «Дайджест уже опубликован сегодня» — но и этот reply может не дойти, если parallel инстанс снова сломал polling.

- timestamp: 2026-05-02
  checked: docker-compose.yml:1-62 (нет `replicas:`, нет `deploy:`, restart: unless-stopped) и docker-compose.override.yml:1-7 (env_file + volumes; merged on local `docker compose up`)
  found: в этом репо нет multi-replica конфигурации. Двойной инстанс приходит ИЗВНЕ — наиболее вероятные источники в порядке убывания вероятности:
    1. На Timeweb App Platform во время rolling deploy старый контейнер не убит до того, как новый поднялся — оба сидят на одном BOT_TOKEN. Свежие коммиты fa0be68 и 7906c66 от 2026-05-01 как раз про prod-докер-образ → последний redeploy ~ ночь 01→02 мая.
    2. Локально пользователь забыл остановить `docker compose up` / `npm run dev` / `node dist/index.js` на ноуте — он держит second long-polling с тем же токеном (override.yml читает .env с тем же BOT_TOKEN).
    3. В Timeweb dashboard вручную включена опция «replicas: 2» (Timeweb App Platform sometimes scales horizontally by default — нужно проверить в UI; в docker-compose это не отражается, sanitizer всё равно бы её снёс).
  implication: docker-compose в репо чист. Корень проблемы — операционный, на стороне платформы / локальной среды. Поведение продакшен-кода (rethrow + exit + restart loop) лишь отражает 409.

## Resolution

root_cause: |
  Главная (она же причина «команды не отвечают» и restart loop):
    Параллельно крутятся ДВА процесса с одним BOT_TOKEN, оба зовут getUpdates (long-polling).
    Telegram отдаёт 409 Conflict тому из них, кто оказался во второй параллельной сессии.
    Grammy 1.42 (node_modules/grammy/out/bot.js:446) пробрасывает 409 наружу из bot.start().
    src/index.ts:33-36 ловит promise rejection, пишет «bot.start() failed» (FATAL) и делает process.exit(1).
    docker-compose.yml:4 `restart: unless-stopped` поднимает контейнер заново — restart loop.
    Доказательство: «Privacy mode OFF, bot will receive group messages» появляется ДВАЖДЫ в одном
    стартап-окне (preflight.ts:34 пишется ровно один раз на bot.start, значит в логе слиты два
    параллельных процесса).
    Откуда берётся второй инстанс — НЕ из docker-compose в репо (он чистый). Подозреваемые:
      • незавершённый старый контейнер на Timeweb после rolling deploy 01→02.05;
      • локальный docker compose / npm run dev / node dist/index.js на ноуте, читающий тот же .env;
      • Timeweb App Platform replicas>1 в dashboard.

  Соп-баги, обнаруженные при разборе (НЕ корень, но мешают чтению лога и состоянию):

  Соп-баг 1 — misleading shared log message:
    src/utils/telegram.ts:31 пишет «Digest message sent to Telegram» при УСПЕХЕ для ОБЕИХ pipelines
    (digest и thread-summary), потому что `sendMessageWithRetry` импортируется и из
    digest.sender.ts:3, и из thread-summary.sender.ts:4. Поэтому в логе строка
    «Digest message sent to Telegram» появляется СРАЗУ ПОСЛЕ «Telegram sendMessage failed after retry»
    и кажется «ложным success digest» — на самом деле это успешный send thread-summary chunk.
    Это НЕ ложный success в смысле bug, но строка дезориентирует.

  Соп-баг 2 — empty thread-summary при LLM outage:
    src/services/summarizer.service.ts:241-246 — при ЛЮБОЙ ошибке LLM-вызова возвращается
    {skipped:true, reason:'llm-error'} БЕЗ throw. Если LLM лежит на ВСЕХ тредах, formatter
    (thread-summary.formatter.ts:138-141) идёт по «empty-digest» ветке D-35 и строит chunk
    «<b>🧵 Сводки тредов · DD.MM.YYYY</b>\n\nтихо: N из N». Sender его шлёт. С точки зрения
    наблюдателя — бот опубликовал «пустую» сводку, хотя реально это outage LLM. Архитектура
    не различает «реально тихий день» от «всё упало».

  Соп-баг 3 — idempotency флаг ставится до доставки:
    src/modules/digest/digest.service.ts:108-117 — `writeState({lastDigestDate: now, lastSkipped, lastItemCount})`
    выполняется ВНУТРИ runDigestPipeline ПОСЛЕ AI filter, но ДО `sendDigest()`. Поэтому при failed
    sendMessage флаг lastDigestDate всё равно обновлён, и следующий /digest от админа получает
    isDigestPublishedToday()=true (bot.ts:73) → reply «Дайджест уже опубликован сегодня» вместо
    повторной попытки. Failed-delivery + idempotency = digest потерян до следующего MSK-дня.
    Тот же паттерн в thread-summary (thread-summary.service.ts:152-157, writeState ДО
    sendThreadSummary в cron handler).

fix:
  (find_root_cause_only — не правил)

  Что нужно проверить пользователю на стороне инфраструктуры (приоритет 1, чтобы остановить кровотечение):
    1. Timeweb App Platform dashboard → проверить, нет ли двух running инстансов / replicas>1 для
       этого приложения. Если да — снести лишний.
    2. Проверить, не запущен ли локально `docker compose up -d` или `npm run dev` или
       `node dist/index.js` с тем же BOT_TOKEN. Остановить.
    3. Проверить через Telegram API руками:
         curl 'https://api.telegram.org/bot<TOKEN>/getMe'
         curl 'https://api.telegram.org/bot<TOKEN>/getUpdates?timeout=0&offset=-1'
       Если на втором запросе вернётся 409 и текст «terminated by other getUpdates request» —
       подтверждение, что где-то висит ещё один polling-клиент.
    4. После остановки лишнего — на Timeweb сделать stop/start контейнера чтобы выйти из restart loop.

  Что стоит починить в коде (отдельные фиксы, не корень — как минимум они скрывают/закрепляют проблему):
    A. src/utils/telegram.ts:31,41 — переименовать «Digest message sent to Telegram» →
       что-то нейтральное вроде «Telegram sendMessage ok» с полем pipeline (передавать как параметр
       SendMessageParams). Снимет дезориентацию при чтении лога.
    B. src/services/summarizer.service.ts:241-246 + thread-summary.formatter.ts:138-141 — при
       reason:'llm-error' на ВСЕХ тредах (skippedCount===totalThreads И ВСЕ skipped по llm-error)
       НЕ публиковать «тихо: N из N», а либо skip publish (lastThreadSummaryDate не ставить!)
       либо ставить отдельный лог + alert. Нынешний текст маскирует outage.
    C. src/modules/digest/digest.service.ts:108-117 — вынести writeState из runDigestPipeline,
       вызывать его в bot.ts /digest и в cron digestHandler ТОЛЬКО ПОСЛЕ успешного sendDigest.
       Аналогично для thread-summary (cron.ts:91-92 — writeState внутри runThreadSummaryPipeline,
       нужно передвинуть после sendThreadSummary). Это снимет «digest потерян до завтра».
    D. src/index.ts:33-36 — вместо немедленного process.exit(1) при `bot.start() failed` сделать
       умную проверку: если err.error_code===409 (conflict) — лог CRITICAL и НЕ exit, а ждать
       backoff 60s+ перед retry. process.exit + restart loop при 409 на Timeweb создаёт лог-шум,
       не решая проблему. Альтернатива: при 409 явно завершиться с exit code, который Timeweb НЕ
       рестартит (если такая опция есть), чтобы restart loop не маскировал operator alert.

verification:
  Главное (двойной инстанс) — устранено пользователем на стороне инфраструктуры (Timeweb=1 replica,
  no local stray; подтверждено в checkpoint-ответе).

  Соп-баги A/B/C/D закрыты в коде четырьмя атомарными коммитами на main:
    25211eb fix(debug-prod-digest-delivery-conflict-A): persist state only after successful Telegram send
    c29dca5 fix(debug-prod-digest-delivery-conflict-B): refuse to publish thread-summary when LLM is fully out
    fb2f1ed fix(debug-prod-digest-delivery-conflict-C): neutral telegram log + pipeline tag
    4785e65 fix(debug-prod-digest-delivery-conflict-D): graceful 409 handling at startup (no busy-loop)

  Каждый коммит несёт unit-тесты, фиксирующие новый контракт:
    A — digest.service.test.ts (6 cases) + digest.sender.test.ts (5 cases) + thread-summary.service.test.ts O5/O5b/O5c
    B — thread-summary.service.test.ts B1..B6 (6 cases)
    C — telegram.test.ts C1..C5 (5 cases)
    D — startup-error.test.ts D1..D6 (6 cases)
  Итого: 17 test files / 114 tests passing; tsc --noEmit clean.

  Дальнейшая прод-верификация (на стороне пользователя): убедиться, что в Timeweb-логах одного startup-окна
  больше не дублируется «Privacy mode OFF», что после неудачной отправки следующий /digest действительно
  пытается переотправить (а не отвечает «уже опубликован сегодня»), что лог пишет «Telegram sendMessage ok»
  c полем pipeline, и что при 409 (если случится) теперь видно один FATAL раз в минуту, а не шторм.

fix: |
  A. src/modules/digest/digest.service.ts + src/modules/digest/digest.sender.ts +
     src/modules/thread-summary/thread-summary.service.ts + src/scheduler/cron.ts +
     src/types/index.ts — split state-write по двум путям. Skip-path (no articles / itemCount<1)
     остаётся в runDigestPipeline (нечего слать). Success-path вынесен в sendDigest и в новый
     помощник markThreadSummaryPublished, вызываемый из cron handler ПОСЛЕ sendThreadSummary.
     Если send бросает — state.json не трогается, повторный /digest действительно повторно шлёт.
     DigestResult/ThreadSummaryResult пробрасывают persistState (и prevState для thread-summary)
     чтобы /dev-digest и /dev-summary семантика не сломались.
  B. src/modules/thread-summary/thread-summary.service.ts + src/types/index.ts + src/scheduler/cron.ts —
     детектор полного LLM-outage: если ВСЕ summaries — skipped с reason:'llm-error', пайплайн
     возвращает chunks=[] и llmOutage:true, формирует ERROR-лог; cron handler видит llmOutage и
     отказывается публиковать, lastThreadSummaryDate НЕ продвигается, следующий цикл повторит.
     Mixed skip-reasons и all-low-volume («тихий день») — поведение прежнее.
  C. src/utils/telegram.ts + src/modules/digest/digest.sender.ts +
     src/modules/thread-summary/thread-summary.sender.ts — переименование лога на нейтральное
     «Telegram sendMessage ok», добавлено опциональное поле pipeline в SendMessageParams,
     pipeline пишется в каждое pino-binding (success / retry / retry-success / fatal).
  D. src/index.ts + src/utils/startup-error.ts (new) — extracted classifier, при 409 Conflict
     пишет FATAL и спит 60s до process.exit(1) — превращает busy-loop в slow-loop, выживается
     для случая rolling-deploy lingering pod, не топит логи. Non-409 ошибки — поведение прежнее.

files_changed:
  - src/modules/digest/digest.service.ts
  - src/modules/digest/digest.service.test.ts
  - src/modules/digest/digest.sender.ts
  - src/modules/digest/digest.sender.test.ts
  - src/modules/thread-summary/thread-summary.service.ts
  - src/modules/thread-summary/thread-summary.service.test.ts
  - src/modules/thread-summary/thread-summary.sender.ts
  - src/scheduler/cron.ts
  - src/types/index.ts
  - src/utils/telegram.ts
  - src/utils/telegram.test.ts
  - src/utils/startup-error.ts
  - src/utils/startup-error.test.ts
  - src/index.ts
