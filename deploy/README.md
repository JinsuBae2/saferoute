# 지원 서버·S3·Bedrock 확인 기록

## 배포본의 소스·라이선스 제공

프로젝트 자체 코드는 [AGPL-3.0-only](../LICENSE), 외부 자료는 [NOTICE](../NOTICE.md)를 따릅니다.
Git checkout의 변경을 커밋한 후 `web`에서 빌드합니다. 빌드는 Git 커밋을 화면 하단 소스·라이선스
링크에 넣으며, 미커밋/미추적 변경이 있는 작업 트리는 거부합니다. Git 메타데이터가 없는 소스
압축본은 그대로 빌드하지 않고 해당 공개 커밋을 checkout합니다. 개발 서버의 링크는 HEAD 기준으로
미커밋 변경을 포함하지 않으므로 개발 서버를 그대로 배포하지 않습니다.

배포 담당자는 공개된 동일 커밋으로 백엔드·AI·웹을 구성하고, 실제 사용자 경로의 관제와 단말에서
소스·LICENSE 링크가 열리며 배포 커밋과 일치하는지 확인합니다. 빌드된 `dist`만 따로 수정하거나
미공개 커밋·예전 서버와 혼합해 배포하지 않습니다. 변경한 운영 설정과 재현에 필요한 파일도
비밀정보를 제외하고 대응 소스로 제공합니다. 모델·자료의 개별 제공 조건과 해시도 확인합니다.
이 절은 배포자의 실행 절차이며 아직 운영 배포·소스 일치 검수 완료 기록은 아닙니다.

D01 #27에서 **2026-11-09(한국 시간)**에 실제 SSH·AWS API로 확인했다. 점검 담당은 배진수다. [공유용 결과 JSON](resource-checks/2026-11-09.json)은 비밀정보를 제외한 확인 결과이며, 전체 서비스 배포 완료 기록은 아니다.

사용자도 같은 서버에 직접 접속해 S3 목록 조회와 Bedrock `OK` 응답을 확인했다고 응답했다. 직접 화면을 관찰한 증거와는 구분한다.

## 1. 서버와 실행 준비

| 항목 | 실제 확인 결과 |
| --- | --- |
| OS·인스턴스 | Ubuntu 24.04.5 LTS, t3.xlarge, x86_64 |
| 리전 | ap-south-1, 뭄바이 |
| CPU | 4 vCPU, Intel Xeon Platinum 8259CL. lscpu상 2코어·코어당 2스레드 |
| 메모리 | 15.41 GiB, 점검 당시 가용 14.78 GiB |
| 루트 파일시스템 | 전체 28.02 GiB, 점검 당시 여유 25.04 GiB |
| GPU·스왑 | PCI 조회에서 가속기 장치 없음, nvidia-smi 없음. 스왑 0 |
| Python·Git | Python 3.12.3, Git 2.43.0 |
| AWS CLI | 2.39.3, 실제 서비스 확인에 사용 |
| 시스템 SDK | boto3·botocore 1.34.46. Converse·GetInferenceProfile 미지원 |
| 가상환경 | 임시 venv 생성·pip 실행 성공 후 정리 |
| systemd·권한 | systemd 255, 비대화식 sudo 사용 가능 |
| 시각 | NTP 동기화 확인, 서버 표시는 UTC |
| Node·npm·Nginx | 아직 설치되지 않음. D02에서 준비 |
| 점검 당시 서비스 | SSH와 로컬 DNS만 대기. 제품 API·웹 앱 배포 전 |

AI는 CPU 실행을 기준으로 A01에서 실제 영상 처리 속도·메모리를 측정한다. 이 사양 확인으로 모델 성능이나 동시 처리량을 보장하지 않는다. 여유 공간·메모리는 시점 값이며 배포 때 다시 확인한다.

## 2. 접속과 팀 전용 터널

호스트·접속 키는 주최측의 팀별 서버 안내에서 확인한다. 공개 저장소에 PEM, 계정 번호, 인스턴스 ID, 개인키 경로, 접속 호스트를 추가하지 않는다. 로컬 접속 키는 소유자만 읽는 0400 권한으로 정리했다.

다음은 자리표시자를 팀 안내의 값으로 바꾸는 접속 예다. 호스트 키 검사를 끄지 않으며, 처음 접속할 때 확인한 호스트 키를 이후 접속에도 사용한다.

```sh
ssh -i "<PEM_PATH>" ubuntu@<HOST>
ssh -i "<PEM_PATH>" -N -L 127.0.0.1:18080:127.0.0.1:8080 ubuntu@<HOST>
```

이번 점검에서는 서버의 `127.0.0.1:8080`에 일회성 응답만 열고, 로컬 `127.0.0.1:18080` SSH 터널을 통해 HTTP 200과 지정 문자열을 확인했다. 임시 서버·터널·가상환경은 모두 종료·정리했다. 외부 공개 앱 포트, 방화벽, Nginx, systemd 서비스는 변경하지 않았다.

D02의 Nginx 8080 → 제어 8000·시나리오 8001·설명 8002 동일 오리진 연결은 아직 구현·검증 전이다. 실제 경로·화면·인증은 [시스템 설계 9절](../docs/04-system-design.md#9-지원-서버-배포-구조)을 따른다. 공개 URL·도메인·HTTPS 제공 여부도 미정이다.

## 3. AWS 인증과 S3

서버의 **EC2 인스턴스 역할**로 접근했다. SDK credential provider는 `iam-role`, STS 주체는 assumed-role로 확인했다. 액세스 키를 발급하거나 `aws configure`에 입력하지 않았다. 로컬 PC에 서버 역할 자격증명을 복사하지 않는다.

| 항목 | 결과 |
| --- | --- |
| 팀 버킷 | hackathon-e5-t04-data |
| 버킷 리전·접근 | ap-south-1, HeadBucket·GetBucketLocation·ListObjectsV2 성공 |
| 시험 범위 | outputs/diagnostics/d01-UUID/probe.json, 무작위 이름의 96바이트 시험 파일 |
| 쓰기 | PutObject + If-None-Match `*` 성공. 기존 객체 덮어쓰기 방지 |
| 읽기 | GetObject 성공, 원본·다운로드 SHA-256 일치 |
| 정리 | 만든 시험 객체만 DeleteObject, 해당 prefix의 남은 객체 0 확인 |
| 시험 객체 암호화 | Put/Get 응답 AES256. 버킷 기본 설정을 확인했다는 뜻은 아님 |
| 버킷 설정 조회 | 공개 접근 차단·기본 암호화·버전 관리 조회는 AccessDenied |

접근 확인은 서버 터미널에서 다음처럼 수행한다. 파일이 없는 경우 `file_count: 0`도 정상 접근 결과다.

```sh
aws s3api list-objects-v2 --bucket hackathon-e5-t04-data --region ap-south-1 --max-keys 5 --query '{file_count: KeyCount}' --output json
```

삭제 시험은 이 점검에서 새로 만든 파일에만 수행했다. 다른 버킷 접근이나 새 버킷 생성 권한은 시험하지 않았다. 객체별·prefix별 조건이 있을 수 있으므로 이번 시험 성공을 모든 경로·대용량 업로드·복원 검증으로 확대하지 않는다. 실제 실행 증거 업로드·PC 백업·복원은 D02·D04에서 확인한다.

[PutObject API](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html)의 `If-None-Match: *`는 기존 객체가 있으면 쓰기를 거부한다. 동일 이름 재사용보다 실행별 UUID prefix를 사용한다.

## 4. Bedrock — 조대성의 A05 인계

| 항목 | 실제 확인 결과 |
| --- | --- |
| 요청 리전 | ap-south-1 |
| 모델·프로파일 | global.anthropic.claude-haiku-4-5-20251001-v1:0 |
| 모델 조회 | Haiku 4.5 foundation model ACTIVE, inference profile ACTIVE·SYSTEM_DEFINED |
| 실제 호출 | AWS CLI `bedrock-runtime converse` 1회 성공 |
| 입력·제한 | `Reply with exactly OK.`, maxTokens=16 |
| 응답 | `OK`, stopReason=end_turn |
| 사용 토큰 | 입력 12, 출력 4, 총 16 |
| 시간 | 응답 metrics.latencyMs=680, CLI 전체 약 1.622초 |
| 추가 직접 확인 | 사용자가 별도로 같은 최소 호출의 정상 응답을 확인했다고 응답 |
| 할당량 | servicequotas:ListServiceQuotas 거부. RPM·TPM 미확인 |

CLI 시간에는 프로세스 시작 등이 포함된다. 이 1회의 짧은 응답으로 실제 상황 설명의 품질·5초 timeout 충족·부하 한도를 입증하지 않는다. 제공 안내의 다른 모델은 호출하지 않았으며 실제 사용 가능 모델로 확정하지 않는다.

프로파일의 `global.`은 글로벌 교차 리전 방식이다. **요청 리전**과 실제 추론 처리 리전을 동일하다고 간주하지 않으며, 실제 처리 리전은 이번 점검에서 측정하지 않았다. [공식 프로파일 문서](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html)를 따른다.

```sh
aws bedrock-runtime converse \
  --region ap-south-1 \
  --model-id global.anthropic.claude-haiku-4-5-20251001-v1:0 \
  --messages '[{"role":"user","content":[{"text":"Reply with exactly OK."}]}]' \
  --inference-config '{"maxTokens":16}' \
  --query '{response: output.message.content[0].text, tokens: usage.totalTokens}' \
  --output json
```

이 명령은 실제 모델을 호출한다. 출력 상한을 명시하고 불필요하게 반복하지 않는다. Converse는 `bedrock:InvokeModel` 권한을 사용하므로 모델 목록 조회 성공과 실제 호출 성공을 따로 기록한다. [Converse API](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html)

**필수 준비:** 서버 시스템 boto3 1.34.46에는 `converse`와 `get_inference_profile` 메서드가 없다. 버전 숫자만 보고 호출 가능하다고 가정하지 않는다. 이번 확인은 최신 AWS CLI로 수행했다. A05는 별도 가상환경에서 Converse·구조화 응답 기능을 지원하는 boto3/botocore를 실제 검증하고 잠금 파일로 고정한다. 시스템 Python 패키지를 덮어쓰지 않는다.

A05는 확정된 모델 ID·요청 리전·서버 역할을 재사용하고, 설명 사실 추출·출력 스키마·버전·기한·timeout·장애 격리·V15를 별도로 구현·검증한다. 이번 최소 응답을 A05 완료로 처리하지 않는다. 실제 출력 한도 512 등은 A05 계약에 맞추고 부담을 제한하는 호출 간격·재시도를 유지한다.

## 5. 제한과 후속 확인

| 확인할 항목 | 관찰한 오류 또는 상태 | 후속 담당·작업 |
| --- | --- | --- |
| Bedrock 모델별 RPM·TPM, 팀 사용 제한 | servicequotas:ListServiceQuotas AccessDeniedException | 조대성·배진수가 운영진에 값 확인, A05 호출 정책 검증 |
| S3 공개 접근 차단 | s3:GetBucketPublicAccessBlock AccessDenied | 배진수가 운영진에 현재 설정 확인, D02 공개 범위 검수 |
| S3 기본 암호화 | s3:GetEncryptionConfiguration AccessDenied | 배진수가 운영진에 현재 설정 확인. 시험 객체 AES256 결과와 구분 |
| S3 버전 관리·보존 정책 | s3:GetBucketVersioning AccessDenied | 배진수·박준영이 D04 백업·복원 계획에 반영 |
| Node 24·Nginx·애플리케이션 환경 | 미설치 | 배진수 D02, 김성은 프론트 빌드 인계 |
| AI 처리 성능·SDK 환경 | 실제 영상·새 SDK 미검증 | 조대성 A01·A05 |
| 공개 URL·도메인·최종 시연 장비 | 미정 | D02·D03 및 팀 확인 |

권한을 확대하거나 공개 접근 설정을 바꾸지 않았다. 메타데이터 조회가 거절됐다는 사실로 버킷이 공개인지, 암호화 기본값이 무엇인지, 버전 관리가 꺼졌는지 단정하지 않는다. 운영진에게 설정값을 확인받는 방법도 있으며 조회 권한 추가가 반드시 필요한 것은 아니다. 현장 사용 가능 시간·장비도 이번 자원 접근 성공으로 확정하지 않는다.

D01은 실제 자원·접근 성공·오류·미확인 사항을 기록한 것으로 완료한다. D02 실제 배포, D03 장애·접속 검수, D04 백업·복원, A01 추론 성능, A05 설명 기능은 각 이슈에서 계속 진행한다. 운영진에게 메시지를 보내거나 별도 AWS 자원·키·정책을 생성한 작업은 없다.

## 6. 후속 A01-2 실제 추론 확인 (2026-11-09)

위 D01 당시 기록과 별도로 [A01-2 #81](../docs/ai/a01-server-validation.md)에서 기존 core·AI lock의 격리 환경을 설치하고 개발 영상 6개 CPU 실측, 정상·불꽃·연기 worker의 자체 API 전송 80개·EOF·로그를 확인했다. 원본 AV1 2개는 직접 디코딩에 실패하여 픽셀·시각 대조를 통과한 FFV1 복사본을 사용했으며, 연기 전송 실행은 예정 샘플 20개 중 12개를 건너뛰었다. 원본 감사 로그 재검사에서 **연기 EOF 전 STALE 1회를 확인하여 관측 유효성 연속 유지 판정은 FAILED로 정정했다.** 최종 모델 채택·전체 배포 합격은 아니다. 시스템 ffmpeg·libgl1과 격리 환경·증거는 남겼고 검증 controller는 종료했다. A05 SDK·Bedrock 설명 검증 상태는 이번 작업으로 바뀌지 않는다.

## 7. 후속 A01-3 입력 준비 개선 (2026-11-09)

[A01-3 #84](../docs/ai/a01-input-latency.md)는 같은 원본 2개의 명시적 UTVideo 무손실 복사본을 사용한다. 모든 프레임·ms 시각, 연기 선택 BGR 샘플, 6개 영상의 기존 검출 수를 대조했다. 같은 모델·worker·유효기간으로 실제 전송 두 번 모두 각 92개 payload 일치, 연기 20/20 분석·건너뜀 0·STALE 0·EOF·로그 검증을 통과했다. 원본 AV1 직접 입력은 여전히 지원 경로가 아니므로 새 준비 스크립트와 runtime manifest를 따른다. 복사본 디스크 크기는 커졌으며 장시간/동시 부하·WFI·실제 배포는 별도다. 새 패키지·서비스 설치 없이 실행했고 검증 listener는 종료했다.

## 8. D02 배포 절차 — 개인 체험방 최소 구성 (#28)

**이 절은 실행 순서이며 배포 완료 기록이 아니다.** 2026-11-11 서버 읽기 전용 점검에서 제품 코드·Node·Nginx·서비스 등록이 모두 없고 디스크 여유 20GB, 메모리 가용 14GiB임을 확인했다. 설정 두 개는 PC의 Nginx와 검증용 제어 서버로만 동작을 확인했다(아래 "PC에서 확인한 것"). 서버 설치·실행·다른 PC 브라우저 확인은 아직 하지 않았다.

구성은 Nginx 하나와 제어 서버 하나다. 개인 체험방은 제어 서버 프로세스가 방마다 제어기와 시뮬레이션을 품으므로 시나리오 실행기(8001)가 필요 없다. 상황 설명(8002)·영상 AI·공동 시연용 시나리오 실행기는 선택이며, 꺼져 있으면 화면이 "연결 실패"·"미연결"로 표시한다.

| 파일 | 설치 위치 |
| --- | --- |
| [nginx-saferoute.conf.example](nginx-saferoute.conf.example) | `/etc/nginx/sites-available/saferoute` |
| [saferoute-controller.service.example](saferoute-controller.service.example) | `/etc/systemd/system/saferoute-controller.service` |

### 8.1 순서

`<COMMIT>`은 `develop → main` PR로 반영한 공개 커밋이다. 서버와 웹 빌드가 같은 커밋이어야 화면 하단의 소스 링크가 맞는다.

서버에서 설치하고 코드를 받는다.

```sh
sudo apt-get update && sudo apt-get install -y nginx python3-venv
sudo snap install node --classic --channel=24/stable
git clone https://github.com/JinsuBae2/saferoute.git ~/saferoute
cd ~/saferoute && git checkout <COMMIT>
python3 -m venv .venv && .venv/bin/python -m pip install -r requirements-core.lock.txt
```

웹도 서버에서 같은 커밋으로 빌드한다(CI와 같은 Node 24). 빌드는 미커밋 변경이 있으면 거부한다. Ubuntu 24.04 기본 저장소의 Node 18은 Vite 7이 요구하는 버전보다 낮아 쓰지 않는다.

```sh
cd ~/saferoute/web && npm ci && npm run build
```

배치하고 서비스로 등록한다.

```sh
sudo rm -rf /var/www/saferoute && sudo cp -r ~/saferoute/web/dist /var/www/saferoute
sudo cp ~/saferoute/deploy/saferoute-controller.service.example /etc/systemd/system/saferoute-controller.service
sudo cp ~/saferoute/deploy/nginx-saferoute.conf.example /etc/nginx/sites-available/saferoute
sudo ln -sf /etc/nginx/sites-available/saferoute /etc/nginx/sites-enabled/saferoute
sudo rm -f /etc/nginx/sites-enabled/default
sudo systemctl daemon-reload && sudo systemctl enable --now saferoute-controller
sudo nginx -t && sudo systemctl reload nginx
```

서버 안에서 먼저 확인한다.

```sh
curl -s http://127.0.0.1/api/health; curl -s http://127.0.0.1/api/rooms/availability
```

브라우저에서 `http://<HOST>`를 열어 개인 체험 시작·화재·해제·초기화·종료를 확인한다. curl 성공만으로 브라우저 확인을 대신하지 않는다.

### 8.2 공개 범위

2026-11-11에 공인 주소(`http://<HOST>`, 포트 80)로 공개하기로 정했다. Nginx 설정은 로그인 없는 방문자가 자기 개인 체험방만 조작하게 하고, 공동 시연 API(`/api/…`, `/sim/…`)는 읽기만 허용한다. 제어 서버(8000)는 계속 127.0.0.1에만 둔다. 서버 안내문상 1024 이상 포트가 바깥에 열려 있으므로 `--host 0.0.0.0`으로 띄우지 않는다. SSH 터널 전용으로 되돌리려면 `listen 127.0.0.1:8080;`으로 바꾼다.

공개 상태의 한계: HTTPS가 아니다. 한 사람이 쿠키를 지우며 반복 입장해 다섯 자리를 모두 차지하는 것을 막지 않는다(자리는 10분 뒤 반환). 공동 시연 화면(`/#/shared`)은 조작할 수 없는 관람용이 된다. 다른 PC·휴대폰 접속 검수는 D03에서 한다.

### 8.3 운영 중 볼 것

- 디스크: 실행 기록이 `/home/ubuntu/saferoute-runs`에 쌓인다. PC 부하 확인에서 방 5개를 30분 계속 쓰면 약 2.3GB였다. `df -h /`로 지켜보고, 부족해지면 서비스를 멈춘 뒤 필요한 기록을 S3로 옮기고 지운다.
- 로그: `journalctl -u saferoute-controller -n 100`, `/var/log/nginx/error.log`.
- 다시 시작: `sudo systemctl restart saferoute-controller`. 진행 중이던 방은 사라지고 화면은 종료 안내를 보여 준다.
- 새 버전: `cd ~/saferoute && git fetch && git checkout <COMMIT>`, `(cd web && npm ci && npm run build)`, `sudo rm -rf /var/www/saferoute && sudo cp -r web/dist /var/www/saferoute`, `sudo systemctl restart saferoute-controller` 순서로 한다. 의존성 잠금 파일이 바뀌었으면 `.venv/bin/python -m pip install -r requirements-core.lock.txt`도 다시 실행한다.

### 8.4 PC에서 확인한 것 (2026-11-11)

Homebrew Nginx 두 벌(터널 전용으로 제한을 뺀 설정, 공개용인 현재 설정)과 검증용 제어 서버(8011, WFI 건물 버전 5, 방 기능 켬)로 확인했다.

| 확인 | 터널 전용 | 공개용(현재) |
| --- | --- | --- |
| `nginx -t` | 통과 | 통과 |
| 첫 화면 / 해시 붙은 자산 | 200 `no-cache` / 200 `immutable` | 같음 |
| 없는 `/api/…`가 index.html로 대체되지 않음 | 404 | 404 |
| API 응답 `Cache-Control: no-store` | 유지 | 유지 |
| 방 입장 → 내 방 상태 → 초기화 → 종료 | 201 → 200 → 200 → 204 | 같음 |
| 쿠키 없이 방 상태 | 401 | 401 |
| 바깥에서 붙인 내부 증표 머리말 | 지워져 공동 상태 200 (직접 접속은 403) | 같음 |
| `/internal/preview` | 404 | 404 |
| 공동 시연 조작 POST `/api/control/reset`, `/sim/restart` | 제어 서버까지 전달(422, 8001 꺼짐 502) | 403, 403 |
| 설명 작업자가 꺼졌을 때 `/api/explanations/current` | 502 | 502 |

확인하지 않은 것: 서버의 실제 설치·systemd 서비스 동작·재부팅 뒤 유지, 다른 PC 브라우저 접속, 뭄바이 왕복 지연, 영상 AI와 Bedrock 설명 연결, 장시간 부하.
