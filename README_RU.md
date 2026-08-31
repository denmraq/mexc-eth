# MEXC ETH TRADER V1.1

V1.1 — диагностическая версия стратегии без изменения весов V1.0.

## Что добавлено
- Полная расшифровка score: EMA 5m/15m, RSI, momentum 5m/15m, breakout+volume, order book, tape.
- Видны raw LONG/SHORT, коэффициент согласия 5m/15m, edge и weak-edge cap.
- Новая SQLite-таблица `decisions`: бот сохраняет каждое решение раз в тик.
- Для каждого отказа от входа сохраняется причина: `OPEN_POSITION`, `DAILY_TRADE_LIMIT`, `DAILY_LOSS_LIMIT`, `LOSS_STREAK_LIMIT`, `COOLDOWN`, `ATR_FILTER`, `SCORE_BELOW_72`, `ENTERED`.
- Сделка связывается с конкретным decision snapshot через `decision_id`.
- Dashboard показывает текущую расшифровку и последние 10 решений.
- Совместимость со старой V1.0 базой: миграция выполняется автоматически, старые сделки сохраняются.
- Добавлена совместимость со старыми именами переменных `.env`, которые могли быть введены вручную.

## Обновление с V1.0
Заменить файлы:
- `app.py`
- `bot/strategy.py`
- `bot/storage.py`
- `bot/engine.py`
- `.env.example` (рабочий `.env` не трогать)

После обновления:
```bash
cd /root/mexc-eth
git pull
docker compose up -d --build
docker compose logs --tail=50
```

Режим PAPER сохраняется. LIVE не включать до проверки журнала решений.
