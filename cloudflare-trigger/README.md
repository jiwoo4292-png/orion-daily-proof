# ORION 감시 알람 설정

Cloudflare Worker `orion-daily-proof-trigger`를 Woo가 배포할 때 사용하는 순서입니다. GitHub의 새 `slot` 입력과 감시기 코드가 먼저 준비되어야 합니다. 현재 파일은 로컬 시험본입니다.

## GitHub 준비

1. `orion-frontend`의 승인된 감시기 커밋 SHA를 기록합니다. `orion-daily-proof`에서 **Settings → Secrets and variables → Actions → Variables**로 이동해 `ORION_WATCH_FRONTEND_PIN`에 해당 SHA를 설정합니다.
2. 비공개 `orion-snapshots`에 Woo 계정으로 열린 이슈 두 개를 만듭니다. 아래 본문을 각각 입력하고 이슈 **번호**만 GitHub Actions Variables에 넣습니다. 감시 작업이 본문과 증거를 갱신합니다.

   | Variable | 해당 이슈의 초기 본문 |
   | --- | --- |
   | `ORION_WATCH_SLOT_LEDGER_ISSUE` | `{"schema":"orion-watch-slots/1","slots":{}}` |
   | `ORION_WATCH_STATE_ISSUE` | `{"schema":"orion-watch-state/1","cursor":null}` |

3. Healthchecks에서 `ORION watcher`를 만들고 **Simple** 주기 `30분`, 유예 `15분`으로 설정합니다. Woo 알림 연동을 붙입니다. 경로가 UUID 하나인 기본 `https://hc-ping.com/<UUID>` Ping URL을 GitHub Actions **Secrets**의 `ORION_WATCH_HEALTHCHECK_URL`에 저장합니다. 감시 완료와 비공개 증거 저장이 성공한 뒤에만 이 URL로 신호를 보냅니다.
4. Cloudflare 준비 중에는 GitHub `ORION_WATCH_SLOTS_ENABLED=false`로 두고 기존 `ORION_WATCH_ENABLED` 값을 유지합니다. 기존 `ORION_WATCH_FRONTEND_TOKEN`은 `orion-frontend` Contents 읽기 권한이, `ORION_WATCH_SNAPSHOTS_TOKEN`은 `orion-snapshots` Issues 읽기·쓰기 권한이 필요합니다. 비공개 증거 작성자는 Woo 계정 `jiwoo4292-png`로 확인합니다.

## Cloudflare에 한 번 붙여 넣기

1. **Workers & Pages → orion-daily-proof-trigger → Settings → Variables and Secrets**로 갑니다. Worker의 평문 변수 `ORION_WATCH_ENABLED`를 `false`로 설정합니다. 기존 `GH_DISPATCH_TOKEN`에는 `orion-daily-proof`에 대한 Actions 읽기·쓰기 권한이 필요합니다. Woo에게 전달되는 Slack 호환 비공개 웹훅 URL을 `ORION_WATCH_ALERT_WEBHOOK` **Secret**으로 저장합니다.
2. 같은 Worker에서 **Edit code**를 엽니다. 배포 편집기의 코드 전체를 [worker.mjs](worker.mjs) 내용으로 한 번 바꿉니다. **Deploy**를 누릅니다. 기존 `workers.dev`와 Preview URL 설정을 유지합니다.
3. `/actions/workflows/orion-source-watch.yml`의 새 입력과 시크릿·변수 설정을 확인합니다. 활성화 승인 후 GitHub에서 `ORION_WATCH_SLOTS_ENABLED=true`, `ORION_WATCH_ENABLED=true`를 설정합니다. GitHub 예비 알람은 UTC 기준 매시 07·22·37·52분입니다.
4. Cloudflare의 **Settings → Triggers → Cron Triggers**에서 기존 일정을 `2,17,32,47 * * * *`로 교체하고 저장합니다. Worker의 `ORION_WATCH_ENABLED=true`를 저장합니다. 이후 두 알람을 각각 유지합니다. Cloudflare 일정 저장이 전파되는 데 최대 15분이 걸릴 수 있습니다. [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

## 활성화 확인과 복구

- 같은 슬롯의 두 알람 중 먼저 처리된 실행에서 `Run ORION watcher`가 한 번 실행되고, 해당 실행이 증거 저장까지 마쳤으면 다른 실행은 `Duplicate watcher slot`으로 종료합니다. 실제 감시가 시작된 뒤 실패한 경우 같은 슬롯에서 다시 수집하지 않고 다음 슬롯으로 넘어갑니다. Healthchecks 상태는 첫 성공 신호 뒤 `Up`으로 바뀝니다.
- 시작 실패를 주입하면 Worker가 같은 슬롯을 한 번 더 요청하고 Woo 알림을 보내야 합니다. 45분 경보 시험은 같은 주기·유예를 가진 별도 테스트 체크를 `Up`으로 만든 뒤 성공 신호를 멈춰 수행합니다. [Healthchecks 설정](https://healthchecks.io/docs/configuring_checks/)
- Cloudflare 알람만 끄려면 Worker 쪽 `ORION_WATCH_ENABLED=false`로 돌립니다. 이때 GitHub 예비 알람은 그대로 동작합니다. 감시 작업 전체를 멈추려면 GitHub의 `ORION_WATCH_ENABLED`도 `false`로 설정합니다.
