# 데이터 확보 문서 생성기 (외부 서버 배포용)

구성: 정적 페이지(`public/index.html`) + 번역 프록시 서버(`server.js`, 의존성 없음).
브라우저는 `/api/translate` 만 호출하고, API 키는 서버 환경변수에만 있습니다.

## 준비물
- Node.js 18 이상
- Anthropic API 키 (https://console.anthropic.com 에서 발급)

## 로컬 실행
```bash
cp .env.example .env     # ANTHROPIC_API_KEY 입력
node server.js           # http://localhost:3000
```

## 배포 방법
**A. 일반 서버(VM, 사내 서버)**
1. 폴더를 서버에 복사하고 `.env` 를 만듭니다.
2. `node server.js` 로 실행합니다. 상시 실행은 pm2(`pm2 start server.js --name task-doc`) 또는 systemd 를 권장합니다.
3. nginx 등으로 HTTPS 를 붙이고 `TRUST_PROXY=1` 을 설정합니다.

**B. Docker**
```bash
docker build -t task-doc .
docker run -d -p 3000:3000 -e ANTHROPIC_API_KEY=발급받은키 --name task-doc task-doc
```

**C. Render / Railway / Fly.io 등 PaaS**
- 저장소를 연결하고 Start Command 를 `node server.js` 로 지정합니다.
- 환경변수에 `ANTHROPIC_API_KEY` 를 등록합니다. (PORT 는 플랫폼이 자동 지정)

## 환경변수
| 이름 | 설명 | 기본값 |
|---|---|---|
| `ANTHROPIC_API_KEY` | 번역용 API 키 (필수) | - |
| `ANTHROPIC_MODEL` | 사용 모델 | `claude-haiku-5-5` |
| `PORT` | 포트 | 3000 |
| `BASIC_AUTH` | `아이디:비밀번호` 설정 시 접속 인증 사용 | 없음 |
| `RATE_PER_MIN` | IP당 분당 번역 횟수 | 20 |
| `TRUST_PROXY` | 프록시 뒤에서 `1` | 0 |

## 운영 시 참고
- 번역 요청마다 API 비용이 발생합니다. 외부에 공개하는 경우 `BASIC_AUTH` 설정을 권장합니다.
- 작업 내용은 최대 2,000자까지 번역됩니다.
- 입력값 자동 저장은 각 사용자의 브라우저 로컬 스토리지를 사용하므로 서버에는 저장되지 않습니다.
