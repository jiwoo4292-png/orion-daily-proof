# Cloudflare에서 ORION 감시기 깨우기 — Woo 설치 안내

Cloudflare Worker가 30분마다 GitHub에 실행 신호만 보냅니다. 실제 CAPR·SVRA 확인과 비공개 증거 저장은 기존 GitHub Actions 감시기가 수행합니다. 사이트 코드와 기존 워크플로 파일은 바꾸지 않습니다.

이 폴더를 머지하는 것만으로 배포·토큰 발급·예약 전환이 이루어지지는 않습니다. 아래 작업은 PR 검토·머지 후 Woo가 직접 진행합니다. 안내의 화면 이름은 2026-11-18 공식 문서 기준이며 계정별 표시가 조금 다를 수 있습니다.

## 1. 시작 전 확인

- Cloudflare Workers **Free** 계정을 사용합니다. 도메인 구매·사이트 이전·유료 플랜 전환은 필요 없습니다.
- Worker 예약은 UTC `11,41 * * * *`입니다. KST에서도 매시 11분·41분, 기본 하루 48회입니다.
- 감시기는 예약·수동 실행 합산 **KST 하루 52회**입니다. 정상 48회 외 여유는 최대 4회이며, 전환일의 이미 사용한 횟수·재시도·중복 호출도 고려해야 합니다.
- `workflow_dispatch`는 일정과 관계없이 `scope=pilot`의 CAPR·SVRA를 즉시 확인합니다. 평시의 GitHub 예약보다 실제 수집량이 늘 수 있습니다.
- GitHub 예약과 Cloudflare 예약을 모두 상시 켜두지 않습니다. 단, **Cloudflare의 첫 실제 성공을 확인할 때까지는 GitHub 변수를 끄지 않습니다.**
- 토큰 값은 채팅·GitHub 파일·PR·스크린샷·로그·일반 환경 변수에 넣지 않습니다. 필요한 곳은 Cloudflare의 **Secret 입력란 한 곳**입니다.

## 2. Cloudflare 무료 계정 만들기

1. [Cloudflare 가입](https://dash.cloudflare.com/sign-up)에서 이메일과 비밀번호로 가입하고 이메일을 인증합니다.
2. 대시보드에서 **Workers & Pages**를 엽니다. 도메인 추가 요청은 이 작업에 필요하지 않습니다.
3. Workers 플랜이 **Free**인지 확인합니다. 기존 계정이면 사용 중인 Cron Trigger가 계정 한도 5개에 도달하지 않았는지도 확인합니다.

## 3. GitHub 전용 토큰을 Woo가 직접 만들기

1. GitHub 오른쪽 위 프로필 → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**을 엽니다.
2. 이름은 용도를 알아볼 수 있게 정하고, **Resource owner**는 `jiwoo4292-png`로 선택합니다.
3. **Expiration**은 **30 days**로 정합니다. 만료일을 별도로 기록하고 만료 전에 갱신합니다.
4. **Repository access** → **Only select repositories** → **orion-daily-proof 하나만** 선택합니다.
5. **Repository permissions** → **Actions: Read and write**만 추가합니다. Metadata 읽기는 기본 포함됩니다. Contents·Workflows 쓰기 권한이나 다른 저장소는 추가하지 않습니다.
6. 토큰을 생성합니다. **값은 채팅에 보내지 말고** 잠시 안전하게 보관한 뒤 아래 Secret 입력란에만 붙여넣습니다. 기존 private watcher용 토큰을 재사용하지 않습니다.

## 4. Worker 만들고 코드 붙여넣기 — 아직 Cron은 추가하지 않기

1. Cloudflare **Workers & Pages** → **Create application** → **Hello World** 템플릿(또는 **Start with Hello World**)을 선택합니다.
2. 이름을 `orion-daily-proof-trigger`로 지정하고 **Deploy**합니다. 이 최초 템플릿에는 아직 예약이 없습니다.
3. 생성된 Worker의 **Edit code**를 엽니다.
4. 이 폴더의 [worker.mjs](./worker.mjs) 전체를 복사해 기본 Worker 코드에 덮어씁니다. 파일 이름이 `worker.js`로 보여도 ES module 코드 그대로 사용할 수 있습니다.
5. **Deploy**를 눌러 실제 배포합니다. **Save**만 누르면 버전 저장에 그칠 수 있습니다.
6. **Settings → Domains & Routes**에서 필요 없는 `workers.dev`와 Preview URL을 비활성화합니다. 도메인·route를 추가하지 않습니다. HTTP URL을 열면 코드상 404이며, 브라우저 방문으로 감시기를 실행할 수 없습니다.
7. **Settings → Observability → Logs**에서 로그 수집을 켜고 표본 수집률을 **100%**로 맞춥니다. Invocation logs 옵션이 보이면 끕니다. 앱이 직접 기록하는 데이터는 `status`, `time` 두 필드뿐입니다.

## 5. GH_DISPATCH_TOKEN을 Secret으로 등록

1. Worker → **Settings → Variables and Secrets → Add**를 엽니다.
2. **Type: Secret**을 선택합니다. 이름은 정확히 `GH_DISPATCH_TOKEN`입니다.
3. 값에는 GitHub에서 방금 만든 토큰을 직접 붙여넣습니다. `Bearer `는 붙이지 않습니다. 코드가 접두사를 추가합니다.
4. **Deploy**하여 적용합니다. 일반 Text 변수나 코드의 문자열로 넣지 않습니다.
5. 같은 Worker의 운영 배포에 Secret이 있는지 확인합니다. 값을 다시 표시하거나 로그로 시험하지 않습니다.

## 6. Cron Trigger 추가하고 첫 실제 실행 확인

1. Worker → **Settings → Triggers / Trigger Events → Cron Triggers → Add**를 엽니다.
2. 사용자 지정 cron에 **`11,41 * * * *`**를 입력하고 저장합니다. 시간대는 **UTC**입니다. 다른 cron을 추가하지 않습니다.
3. 변경 전파에는 최대 **15분**이 걸립니다. 전파 후 다음 11분·41분 실행을 기다립니다. 새 Worker의 Past Cron Events 표시는 최대 30분 늦을 수 있으므로 로그와 GitHub 기록을 함께 확인합니다.
4. Worker의 **Observability → Logs**에서 해당 시각의 `status`가 **200 이상 300 미만**인지 봅니다. 현재 GitHub API 버전은 일반적으로 200을 반환합니다. 코드는 204를 포함한 모든 2xx도 성공으로 처리합니다.
5. [GitHub Actions](https://github.com/jiwoo4292-png/orion-daily-proof/actions/workflows/orion-source-watch.yml) → 새 **ORION external source watch** 실행을 엽니다. branch가 **main**, event가 **workflow_dispatch**인지 확인합니다. UI에서는 수동 실행처럼 표시되는 것이 정상입니다.
6. 실행이 끝난 뒤 **Check sources and retain private issue evidence** 단계에서 `expected > 0`, 각 출처 상태 기록, `notChecked = 0`을 확인합니다. 기존 403 차단은 별도 상태로 기록되어야 하며, 차단 기록을 출처 확인 성공으로 해석하지 않습니다.
7. **Worker의 2xx와 GitHub의 실제 점검 결과를 둘 다 확인한 뒤에만** 다음 단계로 넘어갑니다. API 접수 성공만으로 감시 성공이 보장되지는 않습니다.

예시 로그에는 숫자와 시각만 있습니다. `time`의 `Z`는 UTC이므로 KST는 9시간을 더합니다.

```json
{"status":200,"time":"2026-11-22T05:11:00.000Z"}
```

## 7. 첫 성공 후 GitHub 예약 job 끄기

1. GitHub 저장소 → **Settings → Secrets and variables → Actions → Variables**를 엽니다.
2. **Repository variables**의 `ORION_WATCH_ENABLED`를 편집해 값만 **`false`**로 저장합니다. Secret 항목이 아닙니다.
3. 워크플로 자체를 Disable하지 않습니다. 기존 코드는 변수가 false여도 `workflow_dispatch`를 허용합니다.
4. 이후 Cloudflare발 dispatch 실행이 약 30분 간격으로 생기는지 최소 두 구간 더 확인합니다. GitHub 자체 schedule 레코드는 계속 생길 수 있지만 그 job은 skipped여야 정상입니다.
5. 전환일에는 기존 실행·시험 횟수 때문에 여유가 4회보다 작을 수 있습니다. 결과의 `dailyRuns`·`dailyLimit`도 확인합니다. `daily_limit`이나 `not_due`의 녹색 종료는 실제 출처 점검을 뜻하지 않습니다.

## 8. 11/22 집중 구간과 누락 대응

CAPR·SVRA 목표일은 **2026-11-22 America/New_York**입니다. 요청한 집중 구간은 **KST 11/22 14:00~11/24 14:00**이며 뉴욕 시간으로 **11/22 00:00~11/24 00:00**입니다. 첫 정규 호출은 KST 11/22 14:11, 마지막은 11/24 13:41입니다. 이 구간 안에 기본 호출 96회가 있고 **52회 한도는 구간 전체가 아니라 KST 날짜별**로 계산됩니다.

다음 예약 시각 뒤 약 10분이 지나도 GitHub 실행이 없으면 다음 순서로 확인합니다. 이 10분은 운영 확인 기준이며 서비스의 지연 보장은 아닙니다.

| 확인할 곳 | 확인 내용과 조치 |
| --- | --- |
| Cloudflare Cron | cron이 하나인지, 비활성화되지 않았는지, 변경 후 15분이 지났는지, 계정 Free 한도를 초과하지 않았는지 확인합니다. |
| Worker 로그 없음 | Logs 수집·표본 수집률, Cron Events, 배포 코드와 trigger 연결을 확인합니다. 브라우저에서 HTTP URL을 여는 것은 scheduled 시험이 아닙니다. |
| `status: 0` | 토큰 Secret 누락·빈 값, 네트워크 오류 또는 10초 요청 제한입니다. Secret 이름·운영 배포를 확인하되 값은 출력하지 않습니다. |
| 401 / 403 | 30일 만료·폐기, 대상 저장소와 Actions 쓰기 권한, GitHub 측 제한을 확인합니다. |
| 404 / 422 | 저장소·워크플로 경로, main, 기존 `scope=pilot` 입력과 워크플로 활성화를 확인합니다. |
| 429 / 5xx | API 제한·GitHub 장애를 확인합니다. Worker는 한 번만 재시도하므로 무한 재호출하지 않습니다. |
| Worker 2xx인데 실행 없음 | GitHub Actions에서 필터를 지우고 main의 dispatch 실행·대기열을 확인합니다. [GitHub Status](https://www.githubstatus.com/)도 확인합니다. |
| 실행은 있는데 실제 점검 없음 | `expected`, `notChecked`, `dailyRuns`, `daily_limit`, 출처별 상태와 비공개 증거 저장 결과를 봅니다. 이미 52회면 재호출로 해결되지 않습니다. |

필요하면 Woo가 GitHub **Run workflow → main → pilot**으로 한 번 수동 실행하고 실제 결과까지 확인합니다. 기존에 2xx 접수가 있었는지 먼저 확인해 중복을 줄이고, 이날 남은 52회 예산을 확인합니다. 계속 누락되면 아래 되돌리기를 사용합니다. 노트북 CI 실행기는 사용하지 않습니다.

집중 구간 종료가 감시 종료를 뜻하지는 않습니다. 기존 감시기의 미국 기준 후속 보호 구간(D+3), 결과 발표 여부를 보고 Woo가 종료·복귀 시점을 정합니다. 이 구성에는 자동 종료 기능을 넣지 않았습니다.

## 9. 위험과 되돌리는 순서

- Worker는 실패한 HTTP 응답·네트워크 오류에 **한 번만** 재시도합니다. 최초 요청이 GitHub에 접수됐지만 응답만 유실된 경우 중복 실행이 생길 수 있습니다. dispatch API에는 이 코드가 사용할 중복 제거 보장이 없습니다. 따라서 하루 48회는 기본 횟수이며 실제 실행의 절대 상한이 아닙니다.
- `Actions: Read and write`는 대상 저장소의 한 워크플로에만 한정되지는 않습니다. 전용 저장소 선택·30일 만료·Cloudflare 계정 접근 통제가 필요합니다.
- 최종 실패도 오류 원문을 던지지 않고 숫자 로그만 남깁니다. **Cron Events의 Success 표시만 보지 말고 앱 로그의 2xx와 GitHub 결과를 확인합니다.** Worker는 감시 결과를 polling하거나 경고를 전송하지 않습니다.
- 무료 Cron CPU 예산은 **10ms**, subrequest 한도는 **50**입니다. 이 코드는 최대 두 번만 API를 호출하고 네트워크 대기는 CPU 시간에 포함되지 않지만, 실제 CPU 사용량은 운영 Observability에서 확인해야 합니다.

되돌리기:

1. Cloudflare Worker → Settings → Cron Triggers에서 **이 Worker의 cron만 삭제/중단**합니다.
2. 삭제 전파 최대 15분을 고려해 추가 dispatch가 멈췄는지 확인합니다. GitHub 예약을 동시에 켜두는 시간을 최소화합니다. 긴급히 외부 호출을 차단해야 하면 이 전용 PAT를 GitHub에서 폐기합니다.
3. GitHub Repository variable `ORION_WATCH_ENABLED`를 **`true`**로 복구합니다. 워크플로 자체는 활성 상태로 둡니다.
4. GitHub의 다음 schedule 생성·실제 결과를 확인합니다. 기존 예약 전달 불안정이 되살아날 수 있으므로, 필요하면 남은 일일 예산 안에서 Woo가 수동 pilot 실행을 담당합니다.
5. Cloudflare 사용을 종료하면 전용 PAT를 폐기하고 Worker Secret도 제거합니다. 기존 감시기 토큰은 건드리지 않습니다.

## 10. 개발자용 설정과 로컬 테스트

Woo는 위 **대시보드 설치 방식 하나만** 사용하면 됩니다. [wrangler.jsonc](./wrangler.jsonc)는 같은 구성의 개발자용 배포 설정이며 비밀값이 없습니다. 대시보드에 코드만 붙여넣으면 이 파일은 자동 적용되지 않으므로 위 Secret·로그·cron 설정을 직접 해야 합니다. Wrangler로 관리하기로 바꾸면 이 파일을 원본으로 삼고 대시보드에서 cron을 따로 변경하지 않습니다.

Node.js 24에서 저장소 루트 기준:

```sh
node --check cloudflare-trigger/worker.mjs
node --test cloudflare-trigger/worker.test.mjs
```

테스트는 가짜 fetch와 테스트용 문자열만 사용하며 실제 GitHub 호출·토큰·배포 없이 검증합니다. 실제 토큰이 담긴 `.dev.vars`·`.env`는 필요하지 않습니다. `.gitignore`는 해당 파일과 Wrangler 작업 파일을 제외합니다.

## 11. 12월 전 검토: 감시기 전체를 전용 실행 환경으로 옮기기

향후 구조는 **Cloud Scheduler → 서비스 계정으로 Cloud Run Job 실행 → 컨테이너에서 감시기 전체 수행 → 비공개 증거 저장·알림**입니다. Secret Manager가 필요한 자격 증명을 제공하고, 수집·증거 저장·상태 보고는 Job이 담당합니다. GitHub Actions dispatch는 이 경로에서 제거할 수 있습니다.

장점은 감시 실행까지 GitHub 예약·runner와 분리하고, 실행 시간·로그·재시도·보관을 전용 환경에서 관리할 수 있다는 점입니다. 단점은 컨테이너 빌드·IAM·비밀 관리·결제·운영 부담입니다. Scheduler는 at-least-once 전달이므로 중복 방지·동시 실행 잠금·KST 일일 예산을 공유 저장소에서 유지해야 합니다. 현재 GitHub 전용 실행 문맥 검증도 새 실행 환경에 맞게 Claude가 조정해야 하며, 사이트 템플릿 변경은 별개입니다. 지금 PR에는 이 이전을 포함하지 않습니다.

Scheduler는 결제 계정당 월 3개 job까지 무료이고 초과 시 job당 31일 $0.10입니다. Cloud Run Job·이미지·빌드·네트워크·Secret Manager는 별도 사용량 과금/무료 구간을 확인해야 합니다.

## 공식 참고 문서

- [Cloudflare 대시보드 코드 편집·배포](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/#via-the-cloudflare-dashboard)
- [Secrets 등록](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cron Trigger·UTC·전파·이벤트 확인](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Workers Logs와 invocation logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [Workers Free 한도](https://developers.cloudflare.com/workers/platform/limits/)
- [GitHub fine-grained PAT 관리](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
- [GitHub workflow_dispatch 권한·요청·응답](https://docs.github.com/en/rest/actions/workflows?apiVersion=2026-03-10#create-a-workflow-dispatch-event)
- [Cloud Run Jobs 예약](https://docs.cloud.google.com/run/docs/execute/jobs-on-schedule), [Job Secrets](https://docs.cloud.google.com/run/docs/configuring/jobs/secrets), [Scheduler 전달 특성](https://docs.cloud.google.com/scheduler/docs/overview)
- [Scheduler 가격](https://cloud.google.com/scheduler/pricing), [Cloud Run 가격](https://cloud.google.com/run/pricing)
