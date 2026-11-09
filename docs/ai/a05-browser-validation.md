# A05-3 실제 브라우저·설명 장애 격리

담당 1의 [#100](https://github.com/JinsuBae2/saferoute/issues/100), 상위 [#41](https://github.com/JinsuBae2/saferoute/issues/41). 2026-11-10 KST에 기존 지원 서버의 별도 검증 폴더와 loopback 프로세스, SSH 터널, 로컬 Vite·Playwright Chromium을 연결했다. 제품 런타임 기준 커밋은 `afed22d3cc38962e6242eaffbadc18d5cfb208a4`다. UI·제어·AI·설명 런타임은 수정하지 않았고 재현용 검증 스크립트와 결과만 추가했다.

**담당 1의 개발 통합 검증은 통과했다. 담당 5의 독립 문장 의미 검수, WFI 전체 시연 및 운영 배포 완료는 아니다.** 자세한 응답·근거·해시·명령/ACK 증거는 [공개 JSON](../../deploy/resource-checks/2026-11-10-explanation-browser.json)에 있다.

## 실제 연결과 결과

지원 서버에 자체 `TWO_ROUTE` 제어기와 실제 설명 API를 띄우고, 기존 `a05-v2` / `global.anthropic.claude-haiku-4-5-20251001-v1:0`를 사용했다. 정상 유지를 위한 DETECTOR-A/B는 명시적 SIM 관측이다. 화재 전환은 개발 촛불 원본의 실제 오픈소스 AI 추론이다. 같은 run_id에서 관제와 `SIGN-S`, `SIGN-B` 브라우저 단말을 연결했다.

| 실제 확인 | 결과 |
|---|---|
| 정상 READY | 관제 문장 = 실제 API 문장 = 채택된 원본 설명 로그. run_id·안내 버전 3·AI 작성/모델/근거 시각 표시 일치 |
| 실제 영상 화재 READY | CAM-A FIRE → A 차단 → S의 다음 지점 B, 안내 버전 4. 해당 실제 Bedrock 문장과 관제 표시 일치 |
| 실제 AI 실행 | 51샘플·수신 52개(EOF 포함), 건너뜀 0. 원본 AI 전송과 제어기 VIDEO_AI 수신 payload 전체 일치 |
| 설명 작업자 종료 | Vite의 설명 프록시 HTTP 500, 이전 문장 숨김. 상태 API·화재 경보·S→B 경로 유지 |
| 종료 중 두 단말 | SIGN-S 정면 RIGHT/후면 LEFT, SIGN-B FORWARD. 종료 확인 후 reset 전 각각 검증된 APPLIED ACK 109건 |
| reset·종료 로그 | 기존/새 실행 2개 모두 `tools.verify_run` PASS. 발행 명령 353건, 검증된 APPLIED ACK 349건. reset 후 실행의 명령 4건은 종료 로그에 ACK가 없어 적용 확인 불가 |

전체 설명 작업자의 요청은 **15건, 채택 15건, 기록된 폐기/timeout/오류 0건**, 입력 18,952·출력 2,371토큰이다. 브라우저에서 선택해 보존한 2개 응답만 센 수치가 아니다. 설명 작업자는 기동 후 백그라운드에서도 근거·TTL에 따라 갱신하므로 브라우저 준비 시간의 호출도 포함한다. 종료 이후에는 새 AWS 호출 없이 아래 응답 주입 시험을 했다. 새로운 접근 키·시스템 패키지·방화벽·팀 운영 서비스를 변경하지 않았다.

현재 명령을 새로 발행하는 순간에는 관제의 적용 상태가 PENDING일 수 있다. 이번 증거는 두 단말의 검증된 이전 APPLIED ACK 순번이 계속 증가함과 실제 표시를 확인한 것이며, 화면에 항상 2/2가 표시된다고 주장하지 않는다. 실제 물리 유도등의 점등 시각 측정도 아니다.

## 명시적 응답 주입 시험

실제 설명 작업자를 종료한 뒤 캡처된 READY를 바탕으로 **브라우저의 설명 응답만** 주입했다. 현재 제어기와 단말은 그대로 실행했다. 틀린 ID 시험에는 현재 서버 시각으로 유효한 기한을 부여해 기한 오류가 ID 오류를 대신 가리지 않도록 했다. 아래 결과를 실제 AWS 403/429나 실제 Bedrock의 오답으로 기록하지 않는다.

| 주입 | 확인 결과 |
|---|---|
| PENDING | 문장 없음, 준비 중/제공 불가 상태 표시 |
| 이전 안내 버전 | 문장 없음, “안내가 바뀌어 이전 설명을 숨겼습니다” |
| 다른 건물 버전 | 문장 없음, “다른 건물 자료의 설명이라 숨겼습니다” |
| 만료된 READY | 현재 실행/안내와 같아도 문장 없음. 새로 수신했다고 수명을 다시 시작하지 않음 |
| 실제 reset 후 이전 run_id | 새 실행/안내 상태에서 문장 없음, “다른 실행의 설명이라 숨겼습니다” |

실제 호출 2개와 주입 5개의 형식을 Explanation 계약으로 다시 검사했다. 실제 문장은 채택 로그의 원문과 일치하고 fact_refs가 당시 허용 사실에 속하며, 화면 캡처 상태에서 추출한 사실도 로그의 근거와 일치한다. Codex의 근거 대조에서 정상 문장의 경로/안내 불가와 화재 문장의 원인/차단/경로 주장을 확인했지만, 이는 담당 5의 사람에 의한 독립 V15 의미 검수를 대체하지 않는다.

## 재현·증거

재현은 실제 유료 Bedrock 호출을 수반한다. 이전 [A05-2 실행 환경](a05-explanation-api.md)을 사용하고 기존 서버 서비스와 분리한다. 저장소 루트에서 설명 환경 Python으로 실행하며 AI Python은 symlink를 따라 시스템 인터프리터로 바꾸지 말고 원래 venv 경로를 지정한다. config의 모델 경로와 실제 가중치 SHA256을 먼저 확인한다.

```sh
PYTHONPATH=. .venv-explanation/bin/python deploy/resource-checks/a05-100-browser-server.py --output runs/browser-new --ai-python .venv-ai/bin/python --ai-config configs/ai.example.json --video data/videos/candle-and-match.ogv
```

출력 폴더는 새 경로여야 하며 지정된 개발 촛불 원본 해시가 아니면 서비스 시작 전에 거부한다. `connection.json`의 자체 loopback API 2개만 SSH로 전달하고, Vite의 `SAFEROUTE_API`·`SAFEROUTE_EXPLANATION_API`를 터널 주소로 설정한다. 이번에는 로컬 18800/18802와 Vite 5180을 썼다. SIM API는 연결하지 않아 시나리오 정답 패널에 HTTP 500이 표시되는데, 이 시험은 그 패널 또는 3D의 통합을 검증하는 것이 아니다.

Playwright CLI는 별도 세션을 열고 매번 snapshot으로 화면을 확인한다. 아래 JS 파일은 `playwright-cli run-code --filename <파일>`에 전달하는 함수다. 스크린샷 출력 폴더 `output/playwright/a05-100`을 먼저 만들고 관제 탭에서 실행한다.

1. 실제 정상 READY: [capture-normal](../../deploy/resource-checks/a05-100-capture-normal.js). `/#/sign/SIGN-S`와 `/#/sign/SIGN-B`를 별도 탭에 연다.
2. 서버 출력 폴더에 빈 `fire` 파일을 만들어 실제 AI를 시작한다. [capture-fire](../../deploy/resource-checks/a05-100-capture-fire.js)로 현재 화재 상태/문장/버전을 대조한다.
3. 빈 `stop_explanation` 파일로 자체 설명 작업자만 종료하고 [offline](../../deploy/resource-checks/a05-100-offline.js)으로 API 오류·문장 숨김·경로 및 두 단말 ACK 증가를 확인한다.
4. 실제로 캡처한 화재 READY DTO를 관제 탭의 테스트 전용 `window.__a05ProbeReady`에 넣는다. [browser-faults](../../deploy/resource-checks/a05-100-browser-faults.js)가 상태/버전/기한을 변경해 4개 모의 응답을 주입한다. 실제 앱 소스를 바꾸지 않는다.
5. AI가 정상 EOF로 끝난 뒤 서버 출력 폴더에 빈 `reset` 파일을 만들고 [browser-old-run](../../deploy/resource-checks/a05-100-browser-old-run.js)을 실행한다.
6. 빈 `finish` 파일로 종료한다. 서버 도구는 fire·설명 종료·reset·AI 정상 완료를 확인하고, 정상/예외/10분 제한 종료 모두 자신이 생성한 자식만 정리한다. 브라우저·Vite·SSH 터널은 실행한 쪽에서 별도로 닫는다.

서버 report의 `COMPLETED_AWAITING_BROWSER_ASSERTIONS`는 브라우저 합격을 자체 판정하지 않는다. 실제 화면/응답 단언과 서버 로그를 대조한 뒤 공개 근거에 별도 PASS를 기록했다. 응답 주입 스크립트가 실패하면 남은 route는 별도 세션을 닫아 정리한다. 사용자의 기존 브라우저나 팀 프로세스 전체를 종료하지 않는다.

로컬 원본은 `runs/a05-100-evidence.tgz`, 풀어 놓은 서버 기록은 `runs/a05-100-evidence/runs/browser-actual01`, 화면은 `output/playwright/a05-100`의 PNG 10개다. Git에는 원본 로그·개인 연결 정보·PNG를 넣지 않고 각각 해시와 대조 결과를 남겼다. 소스 해시는 CRLF를 LF로 정규화한 바이트, 원본 보고서/로그/화면 해시는 실제 파일 바이트 기준이다. 공개 AI config의 model_path만 개인 서버 경로 대신 생략 표기를 사용했다.

자체 서버 자식 종료, 브라우저 세션 종료, 로컬 포트 18800/18802/5180 해제를 확인했다. 실제 AWS 권한 철회·429 유발·설명 로그 디스크 장애는 추가로 유발하지 않았다. 해당 서버 동작은 기존 모의 서비스 회귀 검사의 범위이며 실제 브라우저/클라우드 실패로 바꾸어 주장하지 않는다.

화재 캡처 후 재현 스크립트의 최종 판정에도 run_id 일치 검사를 추가했다. 대기 반복이 끝난 경우까지 같은 조건을 적용한 것이며, 보존된 실제 응답/상태도 이 검사를 통과한다. 당시 사용한 화재 스크립트 해시는 `executed_fire_capture_sha256`, 저장소의 최종 스크립트 해시는 `source_sha256`에 따로 기록했다. 이 보강 후 실제 유료 호출을 재실행했다고 주장하지 않는다.

## 남은 범위

G04/G07/G09의 실제 API 결과는 A05-2 기록에 있으며 이번에는 정상/실제 영상 화재 2개 상태의 브라우저 연결을 추가했다. WFI 3D는 TWO_ROUTE와 건물 버전이 달라 화면에서 표시를 거부하는 상태가 정상이고 WFI 전체 시연 완료 증거가 아니다. 담당 5 독립 문장 검수, 담당 2의 상시 배포, 담당 3/5의 WFI 전체 시연 검수는 남긴다. 전체 담당 1 완료/자동 보류 목록은 [인계 기록](role1-handoff.md)을 따른다.
