# Flowchart проєкту OBVCarService.Bot — для Miro (Mermaid)

Три зв'язані діаграми (щоб кожна лишалась читабельною), усі — **доріжки по сервісах** (subgraph = хто виконує/звідки дані) + кольорове кодування. Показано **всі зовнішні виклики**, **всі умови** (ромби) і **паралельні процеси**.

## Як залити в Miro
1. Miro board → **Create → Diagram → Mermaid** (або застосунок «Mermaid to diagram»).
2. Скопіюй **один** mermaid-блок за раз (Miro краще ковтає по одній діаграмі) — вставляй код МІЖ рядками з потрійними лапками, самі лапки не копіюй.
3. Повтори для кожної з трьох діаграм; розклади доріжки-колонки як зручно (Miro дозволяє тягати групи).

## Легенда сервісів (кольори)
- 🧩 **Наш код** (jobs/bot) — оркестрація, чиста логіка, рішення.
- 📞 **Binotel** (АТС) — джерело дзвінків і записів.
- 🟢 **OpenAI** — усі LLM/embeddings-виклики (модель підписана на вузлі).
- 🟣 **ElevenLabs** — транскрипція (STT) + баланс.
- 🔵 **Postgres/pgvector** — читання/запис даних.
- 📨 **Telegram** — вхідні апдейти й вихідні повідомлення/аудіо/алерти.
- 🔶 **Ромб** = умова (розгалуження).

> ⚠️ Два процеси працюють **паралельно й незалежно**, спілкуючись лише через Postgres: **Діаграма 1** = `obv-poller` (cron `*/15`), **Діаграми 2–3** = `obv-bot` (персистентний). Спільна БД — це «місток» між ними.

---

## Діаграма 1 — Інжест дзвінка (`obv-poller`, cron `*/15`)

Збір → транскрипція → атрибуція → per-call аналіз → **гейт мети** → збереження. Ретрай `pending_calls` іде ПЕРШИМ, потім поллінг нових.

```mermaid
flowchart TB
  classDef code fill:#E8EEF7,stroke:#33517A,color:#1b2a4a;
  classDef bino fill:#FDE8D2,stroke:#C87F2E,color:#5a3a12;
  classDef oai fill:#DFF3E4,stroke:#2E8B57,color:#154a2b;
  classDef el fill:#F3E1F5,stroke:#9B4FA1,color:#4a1f4e;
  classDef pg fill:#DCEBF7,stroke:#2B6CB0,color:#173a5e;
  classDef tg fill:#D7ECFB,stroke:#1E88E5,color:#0d3a63;
  classDef dec fill:#FFF6C2,stroke:#B7950B,color:#5a4a00;

  subgraph CODE["🧩 Наш код — obv-poller"]
    START(["cron */15 → node src/jobs/index.js (JOB_TYPE=poll)"]):::code
    RETRY["1) retryPendingCalls() — спершу ретраїмо застрягле"]:::code
    DATT{"attempts ≥ MAX_PENDING_ATTEMPTS (20)?"}:::dec
    FAILSTATUS["markPendingFailed"]:::code
    POLL["2) pollNewCalls()"]:::code
    CHUNKS["splitIntoChunks: діапазон по 23 год"]:::code
    LOOPCALL["для кожного дзвінка в періоді"]:::code
    DEXIST{"callExists у БД?"}:::dec
    SKIP1["пропустити"]:::code
    DDUR{"durationSec ≤ 0? (не відповіли)"}:::dec
    SKIP2["пропустити (missed)"]:::code
    DREC{"recordingStatus = 'uploaded'?"}:::dec
    TCA["transcribeClassifyAndSave()"]:::code
    DEL{"ELEVENLABS_API_KEY заданий?"}:::dec
    DSTEREO{"стерео (≥2 канали)?"}:::dec
    BUILDTURNS["buildTurns(words) → segments з таймкодами"]:::code
    PICK["pickManagerSpeaker: 1) selfIntro (детерм.) → 2) LLM → 3) евристика"]:::code
    NOSEG["segments = null (без таймкодів/аудіо)"]:::code
    RESOLVE["resolveManagerName()"]:::code
    DSHARED{"спільний номер (901/902) або без employeeName?"}:::dec
    EMPNAME["ім'я = employeeData.name (Binotel)"]:::code
    MAPSTEP["→ per-call MAP"]:::code
    DPURP{"callPurpose = 'sales'? ГЕЙТ ЕФЕКТИВНОСТІ"}:::dec
    NULLCLASS["is_success/weakest_stage/score = NULL (0 запитів)"]:::code
    BALCHK["checkElevenLabsBalance()"]:::code
    DBAL{"баланс < ELEVENLABS_MIN_BALANCE_USD і стан змінився?"}:::dec
    FAILSTEP["будь-який крок кинув помилку"]:::code
  end

  subgraph BINO["📞 Binotel"]
    BINLIST[/"stats/list-of-calls-for-period.json"/]:::bino
    BINREC[/"stats/call-record.json → URL mp3"/]:::bino
    BINDL[/"завантаження mp3 (S3)"/]:::bino
  end

  subgraph EL["🟣 ElevenLabs"]
    ELPROBE["ffprobe: к-сть каналів"]:::el
    ELMULTI[/"POST /v1/speech-to-text (use_multi_channel) — стерео"/]:::el
    ELDIA[/"POST /v1/speech-to-text (diarize) — моно"/]:::el
    ELSUB[/"GET /v1/user/subscription (баланс)"/]:::el
  end

  subgraph OAI["🟢 OpenAI"]
    OAISTT[/"транскрипція fallback (OPENAI_TRANSCRIBE_MODEL)"/]:::oai
    OAILABEL[/"лейблінг мовця (gpt-4o-mini)"/]:::oai
    OAIID[/"identifyManager: вибір з roster (gpt-4o-mini, enum)"/]:::oai
    OAIMAP[/"analyzeCallBehaviors — per-call MAP (gpt-4o-mini): callPurpose + behaviors+цитати"/]:::oai
    OAICLASS[/"classifyCall (gpt-4o-mini): isSuccess, weakestStage(4), score(1-10 за рубрикою)"/]:::oai
  end

  subgraph PG["🔵 Postgres"]
    PGCKPT[("app_state.last_polled_until (чекпоінт)")]:::pg
    PGPEND[("pending_calls (черга ретраю)")]:::pg
    PGROSTER[("roster = distinct manager_name")]:::pg
    PGRUBRIC[("app_state.score_rubric (рубрика)")]:::pg
    PGSAVE[("saveCall → calls: transcript, segments, behaviors, call_purpose, класифікація, manager_name")]:::pg
    PGBALSTATE[("app_state.elevenlabs_balance_state")]:::pg
  end

  subgraph TG["📨 Telegram"]
    TGALERT[/"sendAlert (той самий бот @OBVCarServiceWork_bot)"/]:::tg
  end

  START --> RETRY
  RETRY --> PGPEND
  PGPEND --> DATT
  DATT -->|"так"| FAILSTATUS
  FAILSTATUS --> PGPEND
  FAILSTATUS --> TGALERT
  DATT -->|"ні"| TCA
  RETRY --> POLL
  POLL --> PGCKPT
  PGCKPT --> CHUNKS
  CHUNKS --> BINLIST
  BINLIST --> LOOPCALL
  POLL --> PGROSTER
  LOOPCALL --> DEXIST
  DEXIST -->|"так"| SKIP1
  DEXIST -->|"ні"| DDUR
  DDUR -->|"так"| SKIP2
  DDUR -->|"ні"| DREC
  DREC -->|"ні"| PGPEND
  DREC -->|"так"| TCA

  TCA --> BINREC
  BINREC --> BINDL
  BINDL --> DEL
  DEL -->|"так"| ELPROBE
  ELPROBE --> DSTEREO
  DSTEREO -->|"стерео"| ELMULTI
  DSTEREO -->|"моно"| ELDIA
  ELMULTI --> BUILDTURNS
  ELDIA --> BUILDTURNS
  BUILDTURNS --> PICK
  PICK -.->|"крок 2: роль"| OAILABEL
  DEL -->|"ні / впав / нема кредитів"| OAISTT
  OAISTT --> NOSEG

  PICK --> RESOLVE
  NOSEG --> RESOLVE
  RESOLVE --> DSHARED
  DSHARED -->|"так"| OAIID
  DSHARED -->|"ні"| EMPNAME
  OAIID --> MAPSTEP
  EMPNAME --> MAPSTEP
  MAPSTEP --> OAIMAP
  OAIMAP --> DPURP
  DPURP -->|"sales / невідомо (MAP впав)"| PGRUBRIC
  PGRUBRIC --> OAICLASS
  DPURP -->|"info / other"| NULLCLASS
  OAICLASS --> PGSAVE
  NULLCLASS --> PGSAVE
  PGSAVE --> PGCKPT

  TCA -.->|"exception на будь-якому кроці"| FAILSTEP
  FAILSTEP --> PGPEND

  POLL --> BALCHK
  BALCHK --> ELSUB
  ELSUB --> DBAL
  DBAL -->|"так"| TGALERT
  DBAL --> PGBALSTATE
```

**Ключові умови діаграми 1:** черга-ретрай (attempts≥20 → fail+alert); duration≤0 → skip; recording не готовий → в чергу; ElevenLabs є/нема → STT vs OpenAI-fallback; стерео/моно; спільний номер → AI-ідентифікація; **гейт `callPurpose`** (тільки sales → classifyCall, інакше NULL і 0 запитів); поріг балансу ElevenLabs.

---

## Діаграма 2 — Звітність + Динаміка (`obv-bot`, персистентний)

Три тригери (розклад / «Звіт зараз» / статистика менеджера). Серце — `assembleReport`: **reuse заморожених відрізків + живий хвіст**; аналіз кешується в `report_segments`.

```mermaid
flowchart TB
  classDef code fill:#E8EEF7,stroke:#33517A,color:#1b2a4a;
  classDef bino fill:#FDE8D2,stroke:#C87F2E,color:#5a3a12;
  classDef oai fill:#DFF3E4,stroke:#2E8B57,color:#154a2b;
  classDef pg fill:#DCEBF7,stroke:#2B6CB0,color:#173a5e;
  classDef tg fill:#D7ECFB,stroke:#1E88E5,color:#0d3a63;
  classDef dec fill:#FFF6C2,stroke:#B7950B,color:#5a4a00;
  classDef ff fill:#EDE7DE,stroke:#8a7a5c,color:#3a3222;

  subgraph CODE["🧩 Наш код — obv-bot"]
    SCHED(["setInterval 30с — планувальник"]):::code
    DSLOT{"слот настав (now ≥ слот + grace 10хв) і ще не доставлений?"}:::dec
    SKIPS["чекати (ще рано / вже доставлено)"]:::code
    GC["deleteOldManualTails (GC хвостів >2 діб)"]:::code
    MANUAL(["«Звіт зараз» / /report"]):::code
    STATPICK(["Статистика менеджера → вибір"]):::code
    SHOWDYN["showDynamics (головний екран)"]:::code
    DDRILL{"дрілдаун «Звіт за період»?"}:::dec
    ASM["assembleReport(name, start, end)"]:::code
    ENUM["enumerateSegments: день-обмежені межі (kyivDaySegments)"]:::code
    LOOPSEG["для кожного повного відрізка"]:::code
    GETORCOMP["getOrComputeScheduledSegment"]:::code
    DHAVE{"є заморожений scheduled + версія ОК?"}:::dec
    DRECENT{"відрізок недавній (≤24 год)?"}:::dec
    DCHG{"call_ids змінились? (спізнілий дзвінок)"}:::dec
    REUSE["REUSE (без LLM)"]:::code
    ANSEG["analyzeSegment"]:::code
    RDC["reduceFindingsConsistent (self-consistency)"]:::code
    LOOPN["×N прогонів (SEGMENT_CONSISTENCY_PASSES=3) — паралельні"]:::code
    ASSEMBLE["assembleFindings (код): findQuote-верифікація, MIN_EVIDENCE=3, дедуп"]:::code
    CORR["corroborate: лишити підтверджені більшістю прогонів"]:::code
    TAIL["computeTail (хвіст: остання межа → now)"]:::code
    DTAILDUP{"є manual_tail з тим самим call_ids? (дедуп подвійного кліку)"}:::dec
    DMODE{"режим періоду"}:::dec
    TRENDB["buildTrendReport: тренд по днях + findings з уже заморожених (reuse-only)"]:::code
    DYNB["buildDynamicsText: траєкторія по тижнях/місяцях + вердикт росту (без LLM)"]:::code
    DELIVER["deliverReport: header + блоки + фрази"]:::code
    DFIND{"є findings?"}:::dec
    CLIPS["prepareClips (тільки під негативні findings)"]:::code
    FANOUT["фан-аут: кожному отримувачу (report_recipients)"]:::code
  end

  subgraph PG["🔵 Postgres"]
    PGTIMES[("app_state.report_times / delivered_report_slots")]:::pg
    PGSTATS[("getOperatorStats / getDailyTrend / getBucketedTrend (live SQL)")]:::pg
    PGCALLS[("getCallsForReport: кешовані behaviors+segments")]:::pg
    PGSEG[("report_segments: getStored/getScheduledInRange/upsert (кеш аналізу)")]:::pg
    PGIDS[("getCallIdsForOperator (перевірка складу)")]:::pg
    PGREC[("getRecipients / getActiveOperatorsInRange")]:::pg
    PGPROMPT[("app_state.analyze_prompt (guidance reduce)")]:::pg
  end

  subgraph OAI["🟢 OpenAI"]
    OAIRED[/"REDUCE у findings (OPENAI_REPORT_MODEL=gpt-4o)"/]:::oai
    OAIREL[/"verifyFindingsRelevance (gpt-4o) — чи цитати доводять claim"/]:::oai
  end

  subgraph BINO["📞 Binotel"]
    BINREC2[/"getCallRecordUrl + завантаження mp3"/]:::bino
  end

  subgraph FF["⚙️ Система"]
    FFMPEG["ffmpeg: нарізка аудіо-фрагмента (±AUDIO_CLIP_PAD_SEC навколо цитати)"]:::ff
  end

  subgraph TG["📨 Telegram"]
    TGMSG[/"sendMessage: header / тренд / findings / фрази"/]:::tg
    TGAUD[/"sendAudio: аудіо-докази під негатив"/]:::tg
  end

  SCHED --> PGTIMES
  PGTIMES --> DSLOT
  DSLOT -->|"так"| PGREC
  PGREC --> ASM
  DSLOT --> GC
  DSLOT -->|"ще рано / вже доставлено"| SKIPS

  MANUAL --> PGREC
  STATPICK --> SHOWDYN
  SHOWDYN --> PGSTATS
  PGSTATS --> DYNB
  DYNB --> TGMSG
  SHOWDYN --> DDRILL
  DDRILL -->|"так"| DMODE

  ASM --> PGSTATS
  ASM --> ENUM
  ENUM --> LOOPSEG
  LOOPSEG --> GETORCOMP
  GETORCOMP --> PGSEG
  PGSEG --> DHAVE
  DHAVE -->|"так"| DRECENT
  DRECENT -->|"ні (усталений)"| REUSE
  DRECENT -->|"так"| PGIDS
  PGIDS --> DCHG
  DCHG -->|"ні"| REUSE
  DCHG -->|"так (self-heal)"| ANSEG
  DHAVE -->|"ні"| ANSEG

  ANSEG --> PGCALLS
  ANSEG --> PGPROMPT
  ANSEG --> RDC
  RDC --> LOOPN
  LOOPN --> OAIRED
  OAIRED --> ASSEMBLE
  ASSEMBLE --> CORR
  CORR --> OAIREL
  OAIREL --> PGSEG

  ASM --> TAIL
  TAIL --> PGIDS
  PGIDS --> DTAILDUP
  DTAILDUP -->|"так"| REUSE
  DTAILDUP -->|"ні"| ANSEG

  DMODE -->|"day"| ASM
  DMODE -->|"week/month/quarter"| TRENDB
  TRENDB --> PGSTATS
  TRENDB --> PGSEG

  REUSE --> DELIVER
  ASM --> DELIVER
  TRENDB --> DELIVER
  DELIVER --> DFIND
  DFIND -->|"так, є негатив"| CLIPS
  CLIPS --> BINREC2
  BINREC2 --> FFMPEG
  FFMPEG --> TGAUD
  DELIVER --> FANOUT
  FANOUT --> TGMSG
  DSLOT --> PGTIMES
```

**Ключові умови діаграми 2:** слот настав+grace+не-доставлений; заморожений відрізок є/недавній/склад-змінився (reuse vs self-heal); дедуп хвоста по `call_ids`; режим day (сегментна збірка) vs week/month (тренд, reuse-only); є findings → нарізати аудіо. **Паралельне:** планувальник vs on-demand; N прогонів reduce; per-manager цикл; фан-аут отримувачам. Числа — **завжди live**, findings — **з кешу**.

---

## Діаграма 3 — Бот-сервіси: доступ, База знань (RAG), Ролі, Налаштування, Промпт/Рубрика

```mermaid
flowchart TB
  classDef code fill:#E8EEF7,stroke:#33517A,color:#1b2a4a;
  classDef oai fill:#DFF3E4,stroke:#2E8B57,color:#154a2b;
  classDef pg fill:#DCEBF7,stroke:#2B6CB0,color:#173a5e;
  classDef tg fill:#D7ECFB,stroke:#1E88E5,color:#0d3a63;
  classDef dec fill:#FFF6C2,stroke:#B7950B,color:#5a4a00;

  subgraph TG["📨 Telegram (вхід)"]
    UPD(["апдейт: команда / кнопка / текст / документ / контакт"]):::tg
    OUT[/"sendMessage / sendDocument (відповідь, джерела, оригінал файлу)"/]:::tg
  end

  subgraph CODE["🧩 Наш код — auth + сервіси"]
    FEAT["featureOf(ctx): класифікувати апдейт у фічу"]:::code
    DACC{"canAccess(role, feature)?"}:::dec
    DENY["ігнор / відмова"]:::code
    ROUTE{"яка фіча?"}:::dec

    KBADD["KB: аплоуд документа"]:::code
    DAUD{"для кого файл? (mechanic/manager/both)"}:::dec
    EXTRACT["extractPages (unpdf/mammoth/txt) → chunkDocument"]:::code
    KBASK["KB: питання (/ask)"]:::code
    EXPAND["expandQueries: 3 переформулювання"]:::code
    DAUDF["audiencesForRole: фільтр за роллю"]:::code
    BUILDSRC["buildSourcesFooter (код): файли+сторінки+діплінк"]:::code

    ROLES["Ролі (/roles): request_users / контакт / телефон"]:::code
    DPEND{"є user_id?"}:::dec
    SETT["Налаштування (/settings): отримувачі + час звітів"]:::code
    PROMPT["Промпт (/prompt): перегляд/зміна/скидання"]:::code
    RUBRIC["Рубрика (/rubric): перегляд/зміна/скидання"]:::code
  end

  subgraph OAI["🟢 OpenAI"]
    OAIEMB[/"embeddings (text-embedding-3-small)"/]:::oai
    OAIANS[/"відповідь KB (ANSWER_SCHEMA, ~10% загальних знань дозволено)"/]:::oai
  end

  subgraph PG["🔵 Postgres / pgvector"]
    PGUSERS[("bot_users (ролі, кеш) — getUser")]:::pg
    PGKBDOC[("kb_docs (файл+audience)")]:::pg
    PGKBCH[("kb_chunks (vector 1536, page_start/end) — hnsw cosine")]:::pg
    PGSEARCH[("searchKbChunks(emb, k, audiences)")]:::pg
    PGAPP[("app_state: report_times/recipients/analyze_prompt/score_rubric")]:::pg
    PGBU[("upsert/activate/setOperator bot_users")]:::pg
  end

  UPD --> FEAT
  FEAT --> PGUSERS
  PGUSERS --> DACC
  DACC -->|"ні"| DENY
  DACC -->|"так"| ROUTE

  ROUTE -->|"kb_edit (аплоуд)"| KBADD
  KBADD --> DAUD
  DAUD --> EXTRACT
  EXTRACT --> OAIEMB
  OAIEMB --> PGKBDOC
  OAIEMB --> PGKBCH

  ROUTE -->|"kb_ask (/ask)"| KBASK
  KBASK --> EXPAND
  EXPAND --> OAIEMB
  OAIEMB --> DAUDF
  DAUDF --> PGSEARCH
  PGSEARCH --> PGKBCH
  PGSEARCH --> OAIANS
  OAIANS --> BUILDSRC
  BUILDSRC --> OUT

  ROUTE -->|"roles (admin)"| ROLES
  ROLES --> DPEND
  DPEND -->|"так"| PGBU
  DPEND -->|"ні (телефон)"| PGBU

  ROUTE -->|"settings (admin)"| SETT
  SETT --> PGAPP
  ROUTE -->|"prompt (admin)"| PROMPT
  PROMPT --> PGAPP
  ROUTE -->|"rubric (admin)"| RUBRIC
  RUBRIC --> PGAPP
```

**Ключові умови діаграми 3:** централізований гейт `canAccess(role, feature)` на КОЖНОМУ апдейті; audience-фільтр KB за роллю (механік не бачить менеджерських посібників); RAG — multi-query (3 переформулювання) → pgvector-пошук → структурована відповідь + детермінований блок джерел; ролі pending→active за телефоном.

---

## Що зверніть увагу при рев'ю потоку
- **Провенанс даних:** дивись, у якій доріжці вузол — це і є джерело. `communication_score` і `weakest_stage` народжуються ЛИШЕ у `classifyCall` (OpenAI, діаграма 1) і лише для `sales`. `findings` — у `reduceFindingsConsistent` (OpenAI, діаграма 2) з кешованих `behaviors`. Числа звітів — завжди live SQL (Postgres), не LLM.
- **Що кешується раз:** per-call MAP (`calls.behaviors`, інжест) і per-segment REDUCE (`report_segments`, бот). Повторні звіти їх не перераховують.
- **Єдина таксономія:** 4 етапи (`core/stages.js`) — і в `classifyCall`, і в `analyzeCall`.
