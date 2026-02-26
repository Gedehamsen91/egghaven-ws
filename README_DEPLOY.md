# EggHaven WS (Render + Postgres)

## Krav
- Render Web Service: egghaven-ws
- Render Postgres: egghaven-db

## Setup
1) I Render -> egghaven-db -> Connections
   Copy "Internal Database URL"

2) I Render -> egghaven-ws -> Environment
   Add env var:
   DATABASE_URL = (paste Internal Database URL)

3) Deploy / redeploy.

## Test
- Åbn: /health
  Den skal vise {"ok":true,"db":true}