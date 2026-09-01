# Windows Server 배포 안내

## 1. 설치

1. `gyeonggi-progress-statement-win-x64.zip`의 압축을 고객사 서버의 고정 폴더에 풉니다. 예: `C:\Apps\GyeonggiProgressStatement`
2. 필요하면 `config\appsettings.json`에 최초 기본값을 입력합니다. 설치 후에는 프로그램의 `아마란스10 설정` 화면에서 값을 관리할 수 있습니다.
3. 관리자 PowerShell에서 다음 명령을 실행합니다.

```powershell
powershell -ExecutionPolicy Bypass -File C:\Apps\GyeonggiProgressStatement\install.ps1 -OpenFirewall
```

4. 같은 네트워크의 PC에서 `http://서버주소:5080`으로 접속합니다.

설치 스크립트는 Windows 예약 작업으로 서버 시작 시 프로그램을 자동 실행합니다. 제거할 때는 관리자 PowerShell에서 `uninstall.ps1`을 실행합니다. 제거 후에도 `data` 폴더의 DB는 보존됩니다.

## 2. 아마란스10 실연동 설정

`config\appsettings.json`의 값을 다음처럼 설정합니다.

| 설정값 | 설명 |
|---|---|
| `AMARANTH_MODE` | 실연동은 `LIVE`, 시험은 `DEMO` |
| `AMARANTH_BASE_URL` | 고객사 아마란스10 API Proxy 기본 주소 |
| `AMARANTH_COMPANY_CODE` | 회사코드 |
| `AMARANTH_CALLER_NAME` | 더존에서 전달받은 호출 구분명 |
| `AMARANTH_ACCESS_TOKEN` | 서버 인증 AccessToken |
| `AMARANTH_HASH_KEY` | wehago-sign 생성용 HashKey |
| `AMARANTH_GROUP_SEQ` | 아마란스10 그룹시퀀스 |

설정 파일 값은 DB에 저장된 연동값이 없을 때 최초 기본값으로만 사용됩니다. 이후 화면에서 저장한 값은 `data\progress-statement.db`에 보관되고 API 호출에 즉시 적용됩니다. accessToken과 hashKey는 설정 조회 API 및 화면에 다시 노출되지 않습니다.

실연동 요청에는 다음 인증 헤더가 자동 생성됩니다.

- `callerName`: 저장된 callerName
- `Authorization`: `Bearer {accessToken}`
- `transaction-id`: 요청마다 생성하는 30자리 임의 문자열
- `timestamp`: 요청 시점의 Unix timestamp
- `groupSeq`: 저장된 그룹시퀀스
- `wehago-sign`: `HMAC-SHA256(hashKey, accessToken + transaction-id + timestamp + API 경로)`의 Base64 값

현재 공유된 문서에서 확인된 API는 다음과 같습니다.

- 프로젝트 조회: `/apiproxy/api16S15`
- 품목정보 조회: `/apiproxy/api20A00S00701`
- 입고 헤더 조회: `/apiproxy/api20A02S00201`
- 입고 디테일 조회: `/apiproxy/api20A02S00202`

입고 헤더 조회 결과의 `rcvNb`를 입고 디테일 조회 API에 전달합니다. 디테일 응답은 `pjtCd`로 프로젝트를 구분하고, `itemCd`로 설정 품번과 연결합니다. 매입 공급가액은 `rcvgAm`, 부가세는 `rcvvAm`을 사용합니다. 기존의 입고 디테일 추가 등록 API는 호출하지 않습니다.

## 3. 금액 기준

- 매입금액은 입고 디테일의 `rcvgAm` 공급가액을 합산합니다.
- 부가세는 상세 내역에 별도 보관하며 이익 계산에는 포함하지 않습니다.
- 예상 이익 = 계약금액 - 누적 매입금액
- 이익률 = 예상 이익 ÷ 계약금액 × 100
- 실행예산 집행률 = 매입금액 ÷ 실행예산 × 100

## 4. 데이터 백업

운영 데이터는 `data\progress-statement.db`에 저장됩니다. 서버 작업을 중지한 뒤 이 파일을 정기 백업하면 됩니다. 복구할 때는 동일 경로에 DB 파일을 되돌려 놓고 작업을 다시 시작합니다.

```powershell
Stop-ScheduledTask -TaskName "경기산업-기성집행서"
Copy-Item C:\Apps\GyeonggiProgressStatement\data\progress-statement.db D:\Backup\progress-statement.db
Start-ScheduledTask -TaskName "경기산업-기성집행서"
```

## 5. 운영 전 확인할 항목

- 사내 사용자 인증 방식: Windows 통합 인증 또는 별도 로그인
- HTTPS 인증서와 IIS 역방향 프록시 사용 여부
- 아마란스10 운영 인증값과 서버 접근 허용 상태
- 공급가액에 반품, 취소, 마이너스 입고를 반영하는 기준
- 프로젝트 계약금액 변경 시 기존 스냅샷에 적용할 정책
