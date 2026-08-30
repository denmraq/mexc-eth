# Security
- `.env` не коммитить.
- Secret Key только на VPS.
- API key: Futures Trade + IP whitelist VPS.
- Withdrawal permission не давать.
- Для LIVE лучше закрыть публичный порт 8080 через Tailscale/VPN или HTTPS reverse proxy.
