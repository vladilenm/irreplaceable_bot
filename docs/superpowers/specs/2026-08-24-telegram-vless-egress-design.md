# Telegram egress через VLESS Reality

**Дата:** 2026-08-24

**Статус:** proposed; сервер и приложение ещё не изменены

**Область:** Telegram transport, Amsterdam VPS, Xray/VLESS Reality, Timeweb App Platform и персональный профиль v2RayTun

## 1. Контекст

Scheduled digest успешно проходит RSS и LLM pipeline и сохраняется в PostgreSQL outbox, но Telegram delivery повторно завершается безопасным кодом `telegram-network`. Проверка из production-контейнера через grammY `getMe` достигла заданного десятисекундного timeout без HTTP-ответа и без Telegram API code. Это указывает на недоступный сетевой путь до `api.telegram.org`, а не на ошибку bot token, chat ID, forum topic или прав бота.

Production размещён в российском Timeweb App Platform, где прямой маршрут к Telegram ненадёжен. Переносить приложение и PostgreSQL из Timeweb не требуется.

Read-only аудит Amsterdam VPS `147.45.149.185` подтвердил:

- Ubuntu 24.04 LTS и работающий Docker/Compose;
- прямой HTTPS-запрос к `api.telegram.org` получает ответ примерно за 60 мс;
- TCP/443 свободен;
- существующий compose project `tg-parser-demo` работает в собственной Docker network и не публикует host ports;
- на VPS один vCPU, около 1 GiB RAM и достаточно диска для небольшого Xray-процесса.

На VPS пока ничего не установлено и не изменено. Указанные измерения являются снимком состояния на момент аудита, а не постоянной гарантией ресурсов.

## 2. Цели

Решение должно:

1. дать Telegram-клиенту бота устойчивый egress через Amsterdam VPS;
2. направлять через прокси только Telegram Bot API, не меняя маршруты PostgreSQL, Timeweb AI и RSS;
3. не останавливать и не переконфигурировать существующий `tg-parser-demo`;
4. работать в ограничениях Timeweb App Platform без TUN, `privileged`, `cap_add`, `devices` или `network_mode: host`;
5. создать отдельные независимо отзываемые VLESS credentials для бота и личного iPhone;
6. подготовить стандартную `vless://`-ссылку и QR-код, совместимые с v2RayTun;
7. сохранять secrets вне Git, документации и application logs;
8. ограничить Telegram request timeout значением меньше outbox lease;
9. восстановить доставку уже сохранённого digest без повторного RSS/LLM pipeline;
10. иметь понятный rollback, не затрагивающий другой сервис на Amsterdam VPS.

## 3. Не-цели

- Не переносить приложение, PostgreSQL или AI pipeline в Amsterdam.
- Не направлять весь трафик Timeweb-контейнера через VPN.
- Не устанавливать 3x-ui или другую web-панель.
- Не использовать MTProto proxy: grammY работает с HTTPS Bot API, а не с MTProto-клиентским протоколом.
- Не обещать exactly-once Telegram delivery: Bot API не принимает idempotency key для `sendMessage`.
- Не превращать персональный VLESS-профиль в публичный или многопользовательский VPN-сервис.
- Не менять SSH policy, firewall или credentials VPS без отдельного согласования. Опубликованный в чате root-пароль после работ нужно заменить.

## 4. Рассмотренные варианты

### 4.1. Xray + VLESS Reality на Amsterdam VPS — выбран

Официальный Xray container принимает VLESS Reality на TCP/443. В Timeweb-контейнере локальный Xray client предоставляет loopback SOCKS5 endpoint, а grammY использует его только для Telegram.

Преимущества:

- Reality не требует собственного домена и TLS-сертификата;
- стандартный профиль импортируется в v2RayTun;
- один server inbound поддерживает два независимых client UUID;
- не требуется privileged networking;
- существующий Amsterdam-сервис остаётся изолированным.

Цена решения — Xray должен работать и на VPS, и как небольшой userspace client внутри application image.

### 4.2. 3x-ui + VLESS Reality — отклонён

Панель упрощает ручное управление большим числом пользователей, но для двух credentials добавляет web-service, authentication surface, порт/домен и собственный lifecycle. Здесь clients редко меняются, поэтому declarative Xray config проще и безопаснее.

### 4.3. Full-tunnel WireGuard/VPN — отклонён

Полный tunnel может перехватить маршрут к private PostgreSQL и другим Timeweb-сервисам. TUN обычно требует Linux capabilities/devices, которые App Platform не предоставляет. Split routing на уровне приложения надёжнее и уже по области задачи.

### 4.4. MTProto proxy — отклонён

MTProto подходит Telegram client applications, но не является HTTP proxy для `https://api.telegram.org`. Он не решает текущую ошибку grammY.

## 5. Целевая архитектура

```text
Timeweb App Platform (Russia)
  club_bot process
    ├── PostgreSQL private route ───────────────> Timeweb PostgreSQL
    ├── AI/RSS direct HTTPS ────────────────────> current providers
    └── grammY Telegram calls
          └── SOCKS5H 127.0.0.1:<local-port>
                └── bundled Xray client
                      └── VLESS Reality TCP/443 ─> Amsterdam Xray server
                                                    └── api.telegram.org

iPhone / v2RayTun
  └── independent VLESS Reality client ─────────> the same Amsterdam inbound
```

Telegram long polling и все Bot API methods (`getUpdates`, `getMe`, `sendMessage` и остальные вызовы grammY) используют один proxied API client. Остальные HTTP-клиенты приложения не получают proxy agent.

SOCKS URL использует remote DNS semantics (`socks5h`), чтобы hostname `api.telegram.org` разрешался через proxy path, а не через потенциально блокируемый локальный DNS/route.

## 6. Amsterdam Xray server

Новый compose project размещается отдельно, например в `/opt/club-bot-egress`. Он не присоединяется к `tg-parser-demo_default`, не монтирует каталоги существующего сервиса и не меняет его compose file.

Server использует закреплённую версию официального Xray image. Перед rollout фиксируется также image digest, чтобы повторный deploy не подтянул неожиданную новую сборку.

Один inbound использует:

- protocol `vless`;
- transport `tcp`;
- security `reality`;
- flow `xtls-rprx-vision`;
- host mapping `443:<unprivileged-container-port>/tcp`;
- один согласованный Reality `serverName`/`dest`, достижимый с VPS;
- отдельные случайные client UUID `club-bot` и `personal-mobile`;
- отдельный Reality keypair и случайный short ID.

Контейнер запускается без web UI и без privileged mode. Предпочтительные ограничения: non-root user, read-only root filesystem, `no-new-privileges`, dropped Linux capabilities, bounded memory/PIDs и `restart: unless-stopped`. Access logging выключается; error log ограничивается уровнем `warning` и не должен содержать client URI.

Публично открывается только TCP/443. Текущие SSH, Zabbix и firewall settings не изменяются в рамках этого rollout, чтобы не нарушить неизвестные operational dependencies. Их hardening оформляется отдельно.

## 7. Разделение credentials

Server config содержит двух клиентов на одном inbound:

| Client | Назначение | Где используется |
|---|---|---|
| `club-bot` | только Bot API egress | secret environment Timeweb |
| `personal-mobile` | личный iPhone | v2RayTun import link/QR |

У клиентов разные UUID. Компрометация или отзыв мобильного профиля не требует менять bot credential, и наоборот. Reality public key, short ID, host, port и SNI могут быть общими; секретом доступа остаётся прежде всего client UUID вместе с полным import URI.

Полные URI не записываются в Git, design/plan, test fixtures или application logs. На VPS server config и временные export-файлы имеют root-only permissions. Мобильная ссылка и QR передаются пользователю как secret и не публикуются в общих каналах.

Профиль v2RayTun формируется как стандартный VLESS Reality TCP URI с `encryption=none`, `security=reality`, `flow=xtls-rprx-vision`, `type=tcp`, `sni`, `fp`, `pbk` и `sid`. Перед выдачей проверяется именно импорт в v2RayTun на iPhone.

## 8. Application-side proxy

Application image получает закреплённый официальный Xray binary на build stage. Binary запускается дочерним userspace process до Telegram startup и получает сгенерированный client config через stdin либо другой механизм без сохранения credentials в image layer или рабочем каталоге.

Добавляется одна deployment-specific secret variable:

```text
TELEGRAM_PROXY_VLESS_URL
```

Это осознанное исключение из текущего семипеременного production-контракта: proxy endpoint и credential различаются между deployments и не являются безопасным runtime default. После rollout production использует восемь переменных. `.env.example` содержит только имя без значения; сам URI хранится в Timeweb secret storage.

Поведение конфигурации:

- переменная отсутствует — локальная разработка сохраняет текущий direct Telegram transport;
- переменная задана — URI строго валидируется без включения значения в error/log;
- Xray client config строится только из разрешённых VLESS Reality TCP полей;
- локальный SOCKS listener bind-ится только к loopback;
- приложение ждёт readiness SOCKS listener до запуска `bot.start()`;
- ранний выход Xray child считается terminal runtime failure, чтобы App Platform перезапустил весь экземпляр;
- graceful shutdown сначала останавливает новые Telegram operations, затем Xray child.

В production остаётся ровно один экземпляр приложения на `BOT_TOKEN`. Xray child не создаёт второй Telegram poller.

## 9. Telegram timeout и безопасные ошибки

Текущий grammY default client timeout слишком велик для пятиминутного outbox lease. Новый явный timeout должен:

- быть достаточным для Telegram long polling плюс сетевой запас;
- оставаться существенно меньше пяти минут;
- применяться одинаково к direct и proxied grammY transport.

Точное значение фиксируется в `runtime-defaults.ts` после теста long polling; начальная проектная граница — 45–60 секунд. Outbox lease остаётся не меньше чем в три раза длиннее Telegram request timeout.

Safe error classification извлекает разрешённые поля из grammY `HttpError` и nested cause:

- класс ошибки;
- системный code из allowlist (`ETIMEDOUT`, `ECONNREFUSED`, `ECONNRESET`, `ENOTFOUND` и аналогичные);
- numeric HTTP/Telegram code, если ответ получен;
- duration, attempt count, pipeline и publication ID.

Error message, URL с bot token, proxy URI, UUID, payload, prompt и Telegram message text не логируются и не сохраняются в PostgreSQL.

## 10. Delivery и восстановление digest

Proxy меняет только transport; PostgreSQL outbox и at-least-once state machine остаются источником истины.

После production rollout:

1. приложение успешно запускает local Xray и выполняет Telegram startup через него;
2. активная `ready`/`retrying` публикация доставляется обычным dispatcher;
3. `delivering` row повторно claim-ится после истечения lease;
4. если публикация успела перейти в `expired` или `failed`, администратор использует `/retry_publications digest`;
5. `/digest` и `/dev-digest` для восстановления не запускаются, чтобы не повторять RSS/LLM и не создавать потенциальный дубль.

Успех подтверждается статусом `delivered`, сохранёнными Telegram message IDs и продвижением `job_state`, а не только отсутствием ошибки в application log.

## 11. Rollout

Rollout разделяется на контролируемые этапы:

1. Создать root-only Xray server config и новый compose project на Amsterdam VPS.
2. Проверить config встроенной командой Xray до запуска.
3. Запустить только новый Xray container и убедиться, что `tg-parser-demo` не перезапускался.
4. Проверить VLESS path до `api.telegram.org` тестовым Xray client без bot token.
5. Выдать `personal-mobile` URI/QR и получить пользовательское подтверждение работы v2RayTun.
6. По TDD реализовать application-side Xray lifecycle, proxy agent, timeout и safe diagnostics.
7. Выполнить focused tests и полный release gate.
8. Только после явного разрешения добавить `TELEGRAM_PROXY_VLESS_URL` в Timeweb и развернуть проверенный commit.
9. Проверить startup/getMe, один poller, outbox recovery и фактическую доставку сохранённого digest.

Создание Xray service на Amsterdam и изменение Timeweb являются разными external mutations. Перед каждым этапом требуется подтверждение точного действия. Push и production deploy не следуют автоматически из одобрения design.

## 12. Rollback

Amsterdam rollback останавливает и удаляет только compose project `club-bot-egress`; `tg-parser-demo` и его network/volumes не затрагиваются. До удаления сохраняется возможность отозвать отдельный client UUID заменой server config.

Application rollback возвращает предыдущий проверенный image/commit и удаляет proxy variable только по явному решению. Поскольку direct Telegram route из российского Timeweb уже подтверждён как неработающий, такой rollback восстанавливает прежнее приложение, но не Telegram delivery; outbox продолжает сохранять payload до expiry/recovery.

## 13. Риски и меры

| Риск | Мера |
|---|---|
| VPS недоступен | bounded timeout, persisted outbox retry, container restart policy |
| Утечка мобильного URI | отдельный UUID и точечная ротация без изменения bot profile |
| Xray потребляет память VPS | container memory/PID limit и проверка `docker stats` после запуска |
| Порт 443 конфликтует позднее | отдельный compose project и preflight `ss` перед каждым запуском |
| Proxy случайно охватывает DB/AI/RSS | agent передаётся только grammY API client |
| DNS остаётся на блокируемом пути | SOCKS5 remote DNS semantics |
| Telegram принял chunk, но ответ потерян | документированная at-least-once семантика и chunk-level persistence |
| Secret попадает в log/image | stdin/runtime config, redaction tests, отсутствие URI в command output |
| Root-пароль скомпрометирован | сменить опубликованный пароль; SSH hardening выполнить отдельной операцией |

Персональный endpoint обеспечивает обход сетевой блокировки, но сам по себе не является гарантией анонимности: Amsterdam VPS остаётся известной точкой egress.

## 14. Проверки

### Server

1. Xray config validation проходит до startup.
2. Только новый container публикует TCP/443.
3. `tg-parser-demo` сохраняет container ID/start time и остаётся healthy/running.
4. Server VLESS path получает HTTPS-ответ от `api.telegram.org`.
5. После restart Docker Xray автоматически возвращается в running state.
6. Logs не содержат UUID, URI или client payload.
7. Resource usage не создаёт memory pressure для существующего сервиса.

### Mobile

1. URI импортируется в v2RayTun без ручного исправления полей.
2. Connection устанавливается через Reality TCP/443.
3. Telegram и контрольный HTTPS-ресурс доступны через профиль.
4. Bot UUID отсутствует в мобильном export.

### Application

1. Без proxy env existing direct-mode tests проходят без изменения поведения.
2. Невалидный VLESS URI отклоняется без утечки его значения.
3. Proxy mode запускает Xray до grammY и bind-ит SOCKS только на loopback.
4. grammY получает SOCKS5H agent, а AI/RSS clients его не получают.
5. Xray early exit завершает startup/runtime контролируемой безопасной ошибкой.
6. Shutdown не оставляет дочерний Xray process.
7. Telegram timeout меньше outbox lease и совместим с long polling.
8. Nested network cause классифицируется безопасно.
9. Logs и snapshots не содержат proxy URI, UUID, bot token или message payload.
10. Dispatcher после proxy recovery доставляет существующий outbox payload без LLM call.

### Release gate

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Production deploy дополнительно требует проверки единственного bot instance и явного разрешения пользователя.
