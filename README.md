# 경기산업 기성집행서

아마란스10 프로젝트와 품목별 입고금액을 바탕으로 프로젝트별 실행예산, 매입금액, 예상 이익과 이익률을 관리하는 사내용 웹 프로그램입니다.

## 구현 범위

### 집행서
- 대분류, 중분류, 소분류(선택), 분류별 품번 설정과 순서 재배치
- **소분류가 2개 이상인 중분류는 집행서에 '중분류 소계'를 표시**하고, 대분류는 '○○ 합계'로 묶습니다
  (소분류가 없는 중분류는 예전처럼 한 줄 — 첫 소분류를 만들면 중분류에 연결돼 있던 품번이 그 소분류로 옮겨집니다)
- **분류·품번 설정을 버전(설정 세트)으로 관리** — 여러 버전을 보관하고 하나를 '사용 중'으로 지정
- **집행서는 만들 때의 설정 버전을 따라감** — 이후 설정을 바꿔도 이미 만든 집행서는 흔들리지 않고, 어느 설정에서 나왔는지 화면·인쇄물에 표시
- 프로젝트별 분류/품번 스냅샷 생성, 이전 버전 복제, 이름 변경, 작성중 버전 삭제
- **확정 시점의 계약금액을 버전에 고정 보관** — 프로젝트를 다시 동기화해도 확정된 집행서 금액은 바뀌지 않습니다
- 실행예산 및 비고 일괄 저장, Enter 입력 이동, 금액 천 단위 표시, 입력 즉시 잔액·집행률·소계 반영
- 저장하지 않은 변경이 있으면 화면 이동 전에 확인
- 동시 편집 감지 — 다른 사용자가 먼저 저장했으면 덮어쓰지 않고 안내
- 품목별 입고 공급가액 불러오기, 기간 검증, 기존 내역 교체 · 개별/전체 삭제
- 입고 헤더 `/apiproxy/api20A02S00201`와 디테일 `/apiproxy/api20A02S00202` 연계 조회
- 계약금액 대비 예상 이익 및 이익률, 대분류 병합 및 소계, 연결 품번 건수 요약
- A4 가로 기성집행서 인쇄와 Excel 보고서 내보내기

### 접근 통제
- **아마란스10 메뉴트리 진입(SSO) 자동 로그인** — 서명 검증 방식과 파라미터명을 화면에서 지정
- 자체 세션 로그인 (사번/계정 + 비밀번호), 임시 비밀번호 강제 변경, 로그인 시도 제한
- 관리자 / 작성자 / 조회자 3단계 권한
- accessToken, hashKey **AES-256-GCM 암호화 저장**
- CSRF 토큰과 출처(Origin) 검증, CSP 및 보안 헤더
- 로그인·버전 확정·설정 변경 등 주요 작업의 활동 기록

### 운영
- 기록된 모든 집행서 초기화 (확인 문구 입력 전에는 실행 불가)
- SQLite 데이터 저장과 Windows 시작 시 자동 실행
- 일자별 파일 로그(`data/logs`)와 `/api/health` 상태 확인
- 예기치 못한 예외를 기록하고 서버가 조용히 멈추지 않도록 처리

## 개발 실행

Node.js 22.5 이상에서 다음 명령을 실행합니다.

```powershell
.\run-server.cmd
```

`run-server.cmd`는 옆에 `node.exe`가 있으면 그것을, 없으면 PATH의 Node를 사용합니다.
포트가 이미 사용 중이면 **누가 쓰고 있는지 보여 주고 종료할지 물어봅니다.** 묻지 않고 진행하려면 `run-server.cmd /force`,
다른 포트로 띄우려면 `run-server.cmd -Port 5081`을 쓰면 됩니다. 직접 실행하려면 `node src/server.mjs`도 됩니다.

브라우저에서 `http://localhost:5080`을 엽니다. 기본 설정은 `DEMO` 모드입니다.

**최초 실행 시 관리자 계정(`admin`)과 임시 비밀번호가 자동 생성되고, 콘솔과 `data/logs`의 로그에 한 번만 기록됩니다.** 그 값으로 로그인한 뒤 비밀번호를 바꾸고 사용자 화면에서 실제 계정을 등록하세요.

## 검증

```powershell
node --test
node scripts/check-utf8.mjs
```

## Windows 스탠드얼론 패키지

```powershell
powershell -ExecutionPolicy Bypass -File scripts/package-windows.ps1
```

`release\gyeonggi-progress-statement-win-x64.zip` 이 만들어집니다.
**압축을 풀고 `run-server.cmd` 를 실행하면 끝입니다. 대상 PC에 Node.js 를 설치할 필요가 없습니다** — `node.exe` 가 패키지에 함께 들어갑니다.

스크립트가 하는 일:

- 번들할 Node 의 버전(22.5 이상, `node:sqlite` 필요)과 아키텍처를 확인
- `src` `public` `config` 와 실행 스크립트만 골라 담기 (tests·tmp·data·개발 DB 제외)
- `build-info.json` 생성 (버전·빌드 시각·git commit·Node 버전) — 화면 좌하단과 `/api/health` 에 표시됩니다
- `시작하기.txt` 첨부 (설치 없이 실행하는 방법, 최초 관리자 비밀번호 찾는 위치)
- **압축 전에 번들한 node.exe 로 실제 서버를 띄워 `/api/health` 와 로그인 화면 응답까지 확인** — 실패하면 패키지를 만들지 않습니다

검증만 건너뛰려면 `-SkipSmokeTest`, 다른 Node 를 넣으려면 `-NodePath C:
ode
ode.exe` 를 씁니다.

운영 설치, 아마란스10 설정, 메뉴트리 연결은 [DEPLOYMENT.md](DEPLOYMENT.md)를 참고하세요.

## 구성

| 경로 | 역할 |
|---|---|
| `src/server.mjs` | 실행 진입점 — 설정 로드, 로거, 암호화 금고, 종료 처리 |
| `src/app.mjs` | HTTP 서버 조립 — 세션 · CSRF · 정적 파일 · 오류 처리 |
| `src/routes.mjs` | API 라우트 정의와 라우트별 최소 권한 |
| `src/auth.mjs` | 세션, 로그인, 아마란스10 메뉴 진입(SSO) 검증 |
| `src/database.mjs` | SQLite 스키마, 마이그레이션, 모든 조회/저장 |
| `src/calculations.mjs` | 금액·집행률 계산 (`/shared/calculations.mjs`로 화면과 공유) |
| `src/amarance-client.mjs` | 아마란스10 API 호출과 인증 헤더 생성 |
| `src/xlsx-export.mjs` | 수식이 들어간 Excel 보고서 생성 |
| `src/secrets.mjs` | 자격증명 암호화 저장 |
| `src/errors.mjs` | 화면에 보여줄 오류와 내부 오류의 구분, DB 오류 한국어 변환 |
| `src/logger.mjs` | 일자별 파일 로그 |
| `start-server.ps1` / `stop-server.ps1` | 실행·종료 로직과 한글 안내 (`*.cmd`는 이 파일을 부르는 ASCII 런처) |

### 인코딩 규칙

Windows PowerShell 5.1은 BOM 없는 UTF-8 스크립트의 한글을 깨뜨려 파싱 오류를 내고, `cmd.exe`는 배치파일을
OEM 코드 페이지로 읽어 UTF-8 한글을 처리하지 못합니다. 그래서 이 저장소는 다음 규칙을 지킵니다.

- `.ps1` — **UTF-8 with BOM**. 한글 메시지는 여기에 둡니다.
- `.cmd` — **ASCII 전용**. PowerShell 스크립트를 부르는 얇은 런처 역할만 합니다.

`node scripts/check-utf8.mjs`가 이 규칙을 검사합니다.
