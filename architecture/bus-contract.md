# Контракт шины событий Mikoshi — v1 (принят owner 2026-10-09)

Дата: 2026-10-09. Статус: принят (v1). Автор: Куклода по итогам разбора журнала (2942 события, 30 типов) и обсуждения с owner. v1 закрывает замечания ревью v0: писатель очереди, технические отказы, fencing лизов, полнота дедупликации, закрытые PR, источник ответа, определение auto, критерии среза.

## 0. Зачем

Сегодня каждая роль сама ходит в GitHub, сама решает, что изменилось, сама пишет в журнал, а связь между ролями держится на пересказе. Шина делает это одним наблюдаемым контуром:

```
событие → состояние → задача → полномочия → действие → результат
```

Каждое звено записано, каждое можно восстановить и проверить.

Граница полномочий owner не меняется: version-PR, `npm stage approve`, security-invariants, R1 по правилам одобрения (Owner by risk), явно зарезервированные карты, права агентов (`.claude/settings*.json`). Всё остальное шина доводит сама.

## 1. Инварианты (Law)

1. **Один писатель на каждую таблицу.** Доменные проекции (`cards`, `prs`, `decisions`) меняет только редьюсер. Таблицу `tasks` меняет только API очереди (`enqueue`, `lease`, `renew`, `complete`, `fail`, `supersede`): каждое изменение задачи и соответствующее событие `task.*` пишутся в одной транзакции. Воркеры, окна, Atlas не пишут таблицы напрямую.
2. **Сначала факт, потом действие.** Воркер берёт задачу, выведенную из наблюдаемого состояния, а не из догадки или сообщения.
3. **Политика — в момент исполнения.** Право на побочное действие (merge, update-branch, запись вердикта) проверяется непосредственно перед ним, по свежему снимку (head совпадает).
4. **Повторная доставка безопасна.** Дубль события, повтор опроса или перезапуск воркера не дают двойного merge и не теряют задачу (ключ дедупликации, идемпотентные команды, fencing-токен лиза — см. §6).
7. **Технический отказ — работа системы, не владельца.** В инбокс owner попадают только отказы полномочий (§7). Гонки, устаревший head, ошибки GitHub, истёкшие лизы ведут к пересверке и повторной постановке; после 3 неудач — тревога на board, а не задача owner.
5. **Реконсиляция по уровню.** NetWatch на каждом тике берёт снимок GitHub/git и сравнивает с состоянием. Пропущенное событие догоняется следующим тиком; истина — снимок, не поток.
6. **Журнал пишет и решения системы.** Постановка задачи, лиз, попытка, отказ политики, результат, повтор — события, как и факты GitHub. Проза (`note`) в состояние не входит.

## 2. Хранилище

`~/.construct/bus.db` — SQLite в режиме WAL. Один файл, транзакции.

| таблица | что | ключ |
|---|---|---|
| `events` | append-only лог всех событий | `id`; `dedupe_key` UNIQUE |
| `cards` | состояние карты (проекция) | `card_id` |
| `prs` | состояние PR (проекция) | `pr` |
| `tasks` | очереди работ; пишет только API очереди, с событием `task.*` в той же транзакции | `task_key` UNIQUE; `lease_gen` |
| `decisions` | решения owner (проекция) | `decision_id` |

Старый `~/.construct/handoff/ghosts.jsonl` импортируется один раз как события с `legacy=true` и дальше только читается.

## 3. Идентификаторы

- `card_id` — целое, номер карты = номер issue. Везде одно поле, никаких slug в роли id (сегодня карта встречается в `task` числом, в `task` slug-ом и в `card` числом или объектом).
- `pr` — целое. `head` — полный sha.
- `task_key = <queue>:<card_id>:<pr|->:<head|->` — одна задача на одно состояние.
- `actor` — `netwatch | reducer | worker:<kind>:<session> | owner | policy`.

## 4. События

Общие поля: `id, ts, type, actor, card_id?, pr?, head?, dedupe_key, payload`.

**Наблюдения (пишет только NetWatch):**

| тип | payload | dedupe_key |
|---|---|---|
| `pr.observed` | `base, head, mergeable(clean/behind/dirty/blocked), ci(pending/green/red), verdict_on_head?, auto_merge(bool), draft(bool)` | `pr:<pr>:sha256(всех полей payload):<id предыдущего pr.observed этого PR>` — дублем считается только повтор текущего состояния; возврат к прежнему (A → B → A) даёт новое событие |
| `pr.closed` | `merged(bool), commit?` | `pr:<pr>:closed` |
| `main.advanced` | `sha, touches_mechanics(bool)` | `main:<sha>` |

Закрытые PR: NetWatch держит множество известных открытых PR. Каждый тик: открытые из `gh` ∪ известные из `prs`. Известный PR, которого нет среди открытых, запрашивается отдельно → `pr.closed`. Так переход в merged/closed не теряется, даже если опрос его пропустил.

**Жизнь карты:**

| тип | кто пишет | payload |
|---|---|---|
| `card.admitted` | intake | `lane\|axis, decision(auto/owner), contour, depends[]` |
| `card.moved` | intake | `from, to` |
| `card.started` | worker:launch | `session, worktree, branch, base` |
| `card.stopped` | любой воркер | `reason(question.agent/question.owner/review/conflict/fault/ci), detail` |
| `card.answered` | worker:answer | `session` |
| `pr.opened` | worker | `pr` |
| `review.recorded` | worker:review | `head, verdict(pass/changes), reviewer_session` |
| `merge.done` | executor | `commit, rule` |
| `card.closed` | worker:close | `verification` |
| `card.fell` | worker | `kind` |

**Решения системы:**

`task.enqueued`, `task.leased`, `task.renewed`, `task.completed`, `task.failed`, `task.expired`, `policy.allowed`, `policy.denied(rule)`, `command.executed(result)`.

**Решения owner:**

`decision.recorded {text, scope, source:"owner"}` — только через команду владельца. `shard.issued {run, id}`, `shard.used`.

## 5. Автомат карты

```
parked ──admitted→ queued ──started→ running ──pr.opened→ in_review
                     ↑                  │                    │
                     │            stopped(question)    review.recorded
                     │                  │               ┌────┴─────┐
                     └──answered── stopped ←──changes── changes   pass → ready
                                                                     │
                                         pr.closed(merged) ← merge.done
                                                     │
                                                  merged ──closed→ closed
running/in_review ──fell→ fallen ──(≤2 falls)→ queued | (3-я) → sliced
```

Недопустимый переход редьюсер отклоняет событием `reducer.rejected` — а не молча.

## 6. Очереди (выводятся из состояния, каждый тик)

| очередь | условие | воркер | результат |
|---|---|---|---|
| `review` | PR открыт, CI green, нет вердикта на текущем head | review | `review.recorded` |
| `update` | PR behind, и (pass на head или ждёт owner) | update | новый head; вердикт переносится только через чистый update-branch |
| `merge` | pass на head, CI green, mergeable clean | merge (через политику) | `merge.done` или `policy.denied` → инбокс |
| `answer` | карта stopped(question.agent) или changes на текущем head | answer (resume сессии карты) | новый head или `card.stopped` |
| `launch` | карта queued, depends смержены, лайн свободен | launch (отдельным процессом) | `card.started` |
| `restart` | `main.advanced` с `touches_mechanics`, цепочка на старом sha | restart | цепочка на новом main |
| `close` | PR merged, карта не closed | close | `card.closed`, issue закрыт |

**Лиз и fencing.** Лиз: 30 мин, продление heartbeat-ом. Каждый захват увеличивает `lease_gen`; воркер получает его как токен. `renew`/`complete`/`fail` и любая команда исполнителю принимаются только с текущим `lease_gen` — ожившая старая сессия получает отказ и ничего не пишет. Внешние команды дополнительно передают ожидаемый sha в GitHub (`--match-head-commit`).

**Устаревшие задачи.** Новое `pr.observed` с другим head переводит все задачи по старому head в `superseded` (событие `task.superseded`); воркер с такой задачей получает отказ на `complete`.

**Неудачи.** Истёк → `task.expired`, задача снова в очереди. 3 неудачи подряд → `card.stopped(fault)` и тревога на board; в инбокс owner — только если причина — отказ полномочий.

**Источник ответа.** `question.agent` — вопрос, на который отвечает сама система: answer-воркер получает карту, `detail` остановки, последние события карты и дерево; решение принимает Оператор по правилам роли. `question.owner` — вопрос о границе полномочий (R1, owner-путь, reserved): уходит в инбокс owner, ответ owner — `decision.recorded`, после него карта снова `queued`. `changes`: answer-воркер берёт замечания из `review.recorded.payload.findings`.

## 7. Команды и политика

Воркеры не меняют GitHub напрямую — только командой через исполнителя:

`merge(pr, head)`, `update_branch(pr)`, `record_verdict(pr, head, verdict)`, `launch(card)`, `answer(card)`, `close(card)`, `relaunch(role)`.

Правила политики (читаются из `architecture/owner-merges.md`, decisions, shard):

**Определение decision.** `decision` карты выводит intake (механика #775): `owner`, если touches пересекается с глобами `architecture/owner-merges.md` или карта в таблице Owner by risk; иначе `auto`. Новые пути (например `scripts/bus/**`) дают `auto` только через это правило, а не по умолчанию.

**Правила:**

- `merge`: разрешён, если decision `auto`; или `owner` и активен Shard этого прогона — **кроме** version-PR, security-invariants, Owner by risk, «#N reserved».
- `record_verdict`: ревьюер ≠ сессия-автор; head совпадает со снимком.
- `update_branch`, `launch`, `answer`, `close`, `relaunch`: разрешены в рамках allowlist.

**Два вида отказа:**

- `policy.denied(authority, rule)` — нет полномочий. Задача снимается, строка в инбоксе owner.
- `policy.denied(technical, reason)` — `stale_head`, ошибка GitHub, неготовый CI. Задача возвращается в очередь после пересверки; инбокс не трогается.

Перед каждым исполнением — свежий снимок PR; head не совпал → `policy.denied(technical, stale_head)`.

**Свежесть по командам** (флаг `--match-head-commit` не универсален — у каждой команды своя гарантия; проверяется тестом в той карте, где команда включается):

| команда | гарантия свежести в GitHub | при гонке |
|---|---|---|
| `merge` | REST `PUT /pulls/{n}/merge` с `sha` (= `gh pr merge --match-head-commit`): GitHub отказывает, если head другой | 409 → `technical, stale_head`, пересверка |
| `update_branch` | REST `PUT /pulls/{n}/update-branch` с `expected_head_sha` | 422 → `technical, stale_head` |
| `record_verdict` | статус пишется на конкретный sha (`POST /statuses/{sha}`) — вердикт привязан к коммиту сам | новый head без статуса → снова в `review` |
| `launch`, `answer`, `close`, `relaunch` | внешней гарантии нет; защита — fencing `lease_gen` и проверка состояния карты в той же транзакции | отказ на `complete` |

## 8. Проекции (только чтение)

- `board`, `parking-view`, Atlas — из `cards`/`prs`/`tasks`.
- **Инбокс owner** — только: version-PR, R1-одобрения, security-invariants, зарезервированные карты, `policy.denied(authority)`, `card.stopped(question.owner)`. Технические сбои — на board, не в инбокс.
- **Handoff** — генерируется из состояния, не пишется прозой.

## 9. Теневой режим и срез 1

Срез 1: NetWatch + `events` + редьюсер проекции `prs` (и минимальная `cards`: только связь карта ↔ PR) + одна очередь `review`. Без воркеров, ничем не управляет. Полный автомат карты (§5) и остальные очереди в срез 1 не входят — добавляются вместе с потоками, которые их используют.

Детерминизм replay — закон, проверяемый тестом: порядок событий задаётся `events.id`; `lease_gen`, `supersede` и все переходы задач выводятся только из событий; тест прогоняет лог с нуля дважды и сравнивает дампы `prs`/`cards`/`tasks` побайтно.

Критерий выхода среза 1 (24 часа живой работы):

- множество PR в `prs` совпадает с GitHub (открытые + закрытые за период), включая переходы в merged/closed;
- каждый PR с новым head без вердикта появляется в `review` за ≤ 2 тика; задачи по старому head — `superseded`;
- отставание проекции от GitHub ≤ 2 тика на каждом наблюдении;
- ни одного `reducer.rejected` на реальных событиях;
- replay всего лога с нуля даёт побайтно то же состояние `cards`/`prs`/`tasks`.

Срез 2: воркер `review` сам доводит ревью до записанного вердикта вживую — первый поток на шине. Следующий — Оператор выполняет реальную работу через шину, не возвращая рутину owner. Дальше по одному: `update` → `merge` (политика) → `answer` → `launch` → `restart` → `close` → решения owner.

## 10. Решения owner (приняты 2026-10-09)

1. Опрос GitHub раз в 60 с через `gh api` (REST). Срез 1 меряет расход лимита API, обрабатывает 403/429 и `Retry-After`, фиксирует пропуски опросов.
2. NetWatch + редьюсер — один процесс под launchd. После пробуждения — немедленная полная сверка; работа во время сна не предполагается.
3. Старый журнал — идемпотентный импорт с `legacy=true` (повторный запуск не создаёт дублей), оригинал сохраняется, дальше только чтение.
4. Лиз 30 мин, 3 попытки — стартовые значения. Heartbeat, fencing и технические повторы работают независимо от них; 3 неудачи — сигнал на board, не работа owner.
5. Код шины — `scripts/bus/**`. Путь сам по себе не даёт `auto`: decision вычисляется по owner-списку и Owner by risk (§7).

Критерий всей перестройки: Оператор самостоятельно проводит обычную задачу через проверку и исполнение, не возвращая рутину owner.

## 10a. Живость процессов (дополнение к §10.2; owner 2026-10-21, s121, D-74)

§10.2 ставит NetWatch под launchd, но не говорит, кто и по чему решает, что процесс жив. Это правило:

1. **Heartbeat — единственный источник истины о живости.** Каждый долгий процесс — узлы шины, NetWatch, supervisor, цикл `pnpm miko`, сессии карт и answer — пишет в шину `process.heartbeat {role, instance, session?, card?}` не реже раза в `BEAT_MS`. Сегодняшние частные сигналы (heartbeat сессии карты, `window.heartbeat`) становятся частными случаями этого события.
2. **Supervisor — единственный судья.** Жив/мёртв решает только supervisor и только по heartbeat: нет heartbeat дольше `SILENT_MS` → `process.judged {role, instance, verdict: silent|dead}`, тревога на board и перезапуск или снятие — его командой. Ни ps, ни pid-файл, ни `kill -0` живость не решают; никто, кроме supervisor, не убивает процесс по своей оценке.
3. **Один экземпляр.** Процесс при старте читает heartbeat своей роли; живой heartbeat другого экземпляра → отказ стартовать с названием живого экземпляра (`process.refused`), а не второй экземпляр.
4. **Переключатель — флаг, не процесс.** `bus:bg --on|--off` только пишет флаг; поднимает и останавливает узлы supervisor на своём тике.
5. **Supervisor под launchd KeepAlive.** Над supervisor судит launchd: упавший или убитый supervisor поднимается без человека.
6. **Граница.** ps, pid-файлы и kill для живости вне supervisor запрещены правилом: базовый список нарушителей, который только сокращается (как `projection-writes.known.json`).

Технический сбой живости (тишина, перезапуск) — работа системы (закон 7): board, не инбокс owner.

## 11. Карты (после приёмки)

| # | карта | поглощает |
|---|---|---|
| 1 | схема `bus.db` + импорт журнала + идентификаторы | — |
| 2 | редьюсер + автомат карты + `reducer.rejected` | #787, часть #772 |
| 3 | NetWatch: снимок GitHub/git → наблюдения | вход #788, #757 |
| 4 | очередь `review` + теневой отчёт (срез 1) | #788 |
| 5 | воркер `review` вживую (срез 2) | — |
| 6 | исполнитель команд + политика | #721, применение #775, Shard |
| 7 | очереди `update`/`merge`/`answer`/`launch`/`restart`/`close` по одной | #757, #758, #784, #776, #786 |
| 8 | решения owner как команды + инбокс | #755 |
| 9 | планировщик тяжёлых прогонов (слоты quality/vitest) | P8 под нагрузкой |
