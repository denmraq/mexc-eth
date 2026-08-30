# MEXC ETH TRADER V1

Автономный ETH_USDT futures-бот для VPS.

## Архитектура
- официальный MEXC Futures API через `https://api.mexc.com`
- постоянный worker 24/7, браузер не нужен
- 5m + 15m тренд, EMA20/50, RSI, ATR, breakout+volume
- order-book imbalance + recent trade tape как ограниченная microstructure часть
- Risk Engine: риск на сделку, дневной kill-switch, лимит сделок, серия убытков, cooldown
- SQLite журнал на VPS
- Docker `restart: unless-stopped`
- PAPER по умолчанию
- LIVE закрыт двойным предохранителем

## Первый запуск
1. Создай новый GitHub repo.
2. Загрузи содержимое ZIP в корень.
3. На VPS:
```bash
apt update
apt install -y git docker.io docker-compose-v2
systemctl enable --now docker
git clone YOUR_REPO_URL mexc-eth-trader
cd mexc-eth-trader
cp .env.example .env
nano .env
docker compose up -d --build
docker compose logs -f --tail=100
```

Панель: `http://IP_СЕРВЕРА:8080`

Сразу поменять `DASHBOARD_PASSWORD`.

## MEXC API
Для первого PAPER запуска ключи не нужны.
Перед LIVE:
- KYC
- Futures trading permission
- IP whitelist = IPv4 VPS
- без Withdrawal permission
- ключи только в `.env`, не в GitHub

## LIVE
Не включать до PAPER проверки.

Нужно одновременно:
```env
TRADING_MODE=LIVE
ENABLE_LIVE_TRADING=YES_I_UNDERSTAND
LIVE_CONFIRMATION=I_ACCEPT_REAL_MONEY_RISK
```

## Важное
PAPER учитывает 0.10% round-trip taker fee как базовую модель комиссии.
Перед реальной торговлей нужно проверить контрактный размер MEXC, фактический SL/TP и комиссии на минимальном размере.
