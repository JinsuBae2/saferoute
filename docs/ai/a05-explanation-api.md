# A05-2 실제 Bedrock 설명 API

관련: [#88](https://github.com/JinsuBae2/saferoute/issues/88), 상위 [#41](https://github.com/JinsuBae2/saferoute/issues/41). [A05-1 계약](a05-explanation-contract.md)을 사용하는 별도 읽기 전용 프로세스다. 제어기에 설명 작업자의 성공을 기다리는 코드는 추가하지 않았다.

## 실행·연결

Python 3.12의 별도 환경에서 실행한다. 서버 시스템 boto3/botocore 1.34.46은 필요한 API가 없으므로 덮어쓰지 않는다. 신규 AWS 키를 발급하지 않고 지원 서버 IAM 역할을 사용한다.

```sh
python3.12 -m venv .venv-explanation
.venv-explanation/bin/python -m pip install -r requirements-explanation.lock.txt
SAFEROUTE_RUNS_DIR=runs .venv-explanation/bin/python -m uvicorn explanation_worker.app:create_app --factory --host 127.0.0.1 --port 8002 --workers 1
```

Windows는 `.venv-explanation/Scripts/python.exe`를 사용한다. 먼저 기존 제어기를 8000에서 실행한다. 설정은 `configs/explanation.example.json`, 별도 파일은 `SAFEROUTE_EXPLANATION_CONFIG` 환경변수로 지정한다. `enabled:false`는 AWS 호출 없이 DISABLED를 반환한다. 이 API에는 events·arm·clear·명령·ACK 쓰기 경로가 없다.

관제 개발 서버는 `/api/explanations/`를 8002로 먼저 프록시한다. 주소 변경은 `SAFEROUTE_EXPLANATION_API`를 사용한다. 배포용 [Nginx location 예제](../../deploy/nginx-explanation.conf.example)는 해당 사이트의 server 블록에 통합해야 한다. 이번 검증은 자체 loopback 프로세스로 수행했으며 서버의 상시 서비스·Nginx·방화벽을 배포하거나 변경하지 않았다.

`GET /api/explanations/current`는 알려진 상태에 HTTP 200, 현재 제어 상태를 읽을 수 없으면 503을 반환한다. 모두 `Cache-Control:no-store`다. READY에는 `X-Explanation-Server-Time` 헤더가 함께 오며 관제는 이 서버 시각과 HTTP 왕복 시간을 이용해 남은 기한을 보수적으로 계산한다. PC의 날짜·시간을 기준으로 TTL을 새로 시작하지 않는다. 제어 상태·시나리오·설명을 독립 조회하며 설명 실패가 상태 갱신을 기다리게 하지 않는다. 상태 조회 실패·버전 불일치·만료 시 문장을 숨긴다.

## 호출·채택·실패 정책

- 기본 ap-south-1, `global.anthropic.claude-haiku-4-5-20251001-v1:0`, 고정 프롬프트 `a05-v2`. SDK는 boto3/botocore 1.43.126 및 전이 의존성을 고정했다.
- Converse의 `outputConfig.textFormat`에 summary/fact_refs만 있는 고정 JSON Schema를 사용한다. 키·형식·중복/미등록 사실 ID·완료 stopReason을 추가 검증한다. 설정 기본값은 최소 간격 5초·요청 5초·근거 TTL 15초·최대 출력 512토큰이며 SDK 자동 재시도는 없다.
- 요청은 한 개만 실행한다. 5초를 넘으면 결과를 게시하지 않으며, SDK 호출이 실제 종료되기 전에는 다음 호출을 시작하지 않는다. timeout은 API의 채택 제한이며 원격 AWS 작업의 취소·과금 취소를 보장하지 않는다. 완료를 관측하는 주기는 250ms라 UNAVAILABLE 전환에는 스케줄링 지연이 있을 수 있다.
- 현재 run/building/guidance와 근거 시각을 검증하고 이전 실행·버전·만료 결과를 폐기한다. 동일 버전의 유효한 READY만 재사용한다. 로그 I/O 후 현재 시각과 제어 상태를 다시 확인한다. 제어 상태 단절을 거친 진행 요청도 폐기한다.
- 403·429·SDK 실패는 BEDROCK_UNAVAILABLE, 형식·사실 ID 오류는 INVALID_RESPONSE, 근거 불일치는 STALE_BASIS다. 일반적인 응답 형식 검사와 한국어 내용의 사실성 검수는 다르다. 자연어의 모든 주장을 자동 검증한다고 보장하지 않는다.

[AWS 공식 구조화 출력 문서](https://docs.aws.amazon.com/bedrock/latest/userguide/structured-output.html)에 따르면 최초 스키마 준비는 장시간 걸릴 수 있다. 첫 준비 호출은 별도로 측정하고 게시하지 않았다. 이후에도 첫 호출이 5초를 넘으면 UNAVAILABLE이 정상이며 제한을 늘리거나 오래된 결과를 게시하는 우회는 없다. 요청 지역은 ap-south-1이고 global 프로파일의 실제 추론 처리 지역은 확인하지 않았다. RPM/TPM 한도도 기존 D01과 같이 미확인이다.

## 기록·운영 제한

`runs/<run_id>/explanations.jsonl`에 요청 ID·허용 근거·모델·프롬프트·요청/응답 시각·토큰/지연·채택/폐기 사유를 append하고 fsync한다. 채택된 설명도 기록한다. 오류에 SDK의 비밀정보가 섞인 전체 메시지를 복사하지 않는다. 로그 실패 시 해당 프로세스의 설명을 EXPLANATION_LOG_ERROR로 중단하고 추가 호출을 하지 않는다. 제어기는 독립 동작한다.

같은 기록 루트는 `.explanation-worker.lock`으로 한 프로세스만 사용한다. 정상 종료는 잠금을 해제한다. 강제 종료 뒤 잠금이 남으면 해당 PID/프로세스가 종료됐는지 확인한 후 잠금 파일만 정리하고 재시작한다. 실행 중인 잠금을 삭제하지 않는다. 원래 제어 로그·manifest를 덮어쓰지 않는다. 기본 접근 범위는 로컬·SSH 터널이며 외부 공개용 인증/운영 배포 완료가 아니다.

## 실제 검증·재현

지원 서버에서 고정 SDK와 별도 환경을 사용한 결과는 [실측 JSON](../../deploy/resource-checks/2026-11-09-bedrock-explanation.json)에 있다. 정상/실제 개발 영상 화재 우회/양쪽 차단/필수 관측 불가/복구의 5개 API 결과에 입력 근거·문장·참조·안내 버전·사용량을 보존한다. G02는 실제 기존 오픈소스 모델·AI worker·candle/match 개발 영상을 사용한다. 나머지 상태 전이는 자체 제어기의 가상 감지기와 명시적 clear로 구성한 개발 시험이다.

최종 v2 시험(actual-05)은 요청 7건·채택 6건·폐기 1건·timeout 0건, 입력 10,172/출력 1,268토큰이었다. 실제 AI prediction은 51회다. 5개 선정 결과의 원문·근거는 실측 JSON으로 인계하며 독립 평가는 PENDING이다. 원본 실행 report/설명 로그/AI prediction의 해시는 원래 파일 바이트 기준, source_sha256은 Git과 대조할 수 있도록 CRLF를 LF로 정규화한 파일 바이트 기준이다. 처음 스키마 준비 호출은 별도 2.720초·입력 1,454/출력 136토큰이었으며 위 최종 시험 합계에 포함하지 않는다.

로컬에서도 실제 Vite 개발 프록시를 실행해 `/api/explanations/current`의 DISABLED/200과 `/api/state`의 200·동일 run_id·no-store/서버 시각 헤더를 확인했다. 이 프록시 검증에서는 AWS를 호출하지 않았다. 브라우저 화면을 사람이 관찰한 전체 시연 검수는 별도다.

```sh
.venv-explanation/bin/python -m tools.validate_explanation \
  --output runs/a05-new-evidence \
  --ai-python .venv-ai/bin/python --ai-config configs/ai.example.json \
  --video data/videos/candle-and-match.ogv \
  --video-sha256 248be916e95fe7fa5155c94125d60abb3e611721f1f14de7629c2572eb99c3e5
```

이 명령은 **실제 유료 Bedrock 호출**을 하며 자체 제어기/API를 임시 loopback 포트에 띄운다. 새 증거 폴더만 허용하고 완료·실패 모두 생성한 프로세스를 종료한다. 원본 영상·가중치는 Git에 없으며 [A01 인계](a01-model-validation.md)대로 준비해야 한다. 출력의 PASS는 5개 상태의 실제 응답·API 연결 성공이다. 문장 의미의 독립 V15 합격 판정은 아니다.

첫 actual-01은 검증 도구가 venv Python 심볼릭 링크를 시스템 Python으로 해석해 AI import가 실패했다. 도구의 실행 경로 보존을 수정한 actual-02가 5개 상태를 통과했다. 로그 저장 뒤 상태/기한 재검사를 보완한 actual-03도 API 검사를 통과했지만, 개발자가 문장을 대조하며 경로 없음과 차단의 표현 혼용을 발견했다. 따라서 프롬프트 v2에서 둘을 구분하고 상태 전환 이력·안전/이용 가능 단정을 피하도록 수정해 actual-04로 다시 검증했다. 최초 실패나 문장 결함이 있는 후보를 독립 품질 PASS로 바꾸지 않았다.

이후 부분 기록된 로그를 재시작 시 덧붙이지 않고 보존하는 검사와 검증용 AI의 종료 지연 시 kill 정리를 보강했다. 최종 소스 actual-05에서 5개 실제 상태와 서버 집중 검사 30개를 다시 통과했으며 자체 프로세스를 모두 종료했다. 실측 JSON의 소스 해시는 이 최종 실행에 대응한다.

자동 회귀 검사는 `tests/test_explanation_service.py`에서 timeout·단일 진행 호출·403/429 분류·잘못된 JSON/참조·이전 실행/건물/안내·단절·로그 실패·로그 중 만료와 장애 중 제어/명령/ACK 처리를 검증한다. 이 장애 응답은 모의 주입이며 실제 AWS 권한을 철회하거나 서비스 한도를 소진한 시험은 아니다. 프론트는 서버 시각/왕복 시간·독립 조회를 검사한다.

5번 담당자의 G01/G02/G04/G07/G09 독립 문장 대조, 실제 브라우저/WFI 전체 시연, 운영 배포 검수는 #41에서 이어간다. 이번 실제 호출·API 연결 완료만으로 상위 #41을 닫지 않는다.
