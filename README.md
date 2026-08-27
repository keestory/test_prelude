# PRELUDE 재고·발주관리

PRELUDE의 재고, SKU, 발주처, Google Sheets 발주 양식을 한 화면에서 관리하는 웹 프로토타입입니다.

## 실행

Node.js 24 이상에서 다음 명령으로 로컬 실행합니다.

```bash
node server.mjs
```

브라우저에서 `http://127.0.0.1:4173/index.html`을 엽니다.

## 검증

```bash
node --check server.mjs
node --test tests/*.test.mjs
```

## 배포 구조

- 프런트엔드: GitHub Pages
- Google Sheets 검사와 XLSX 프록시: Supabase Edge Function `google-sheets`
- 운영 데이터: Supabase Postgres의 공개 공유 `prelude_workspaces` JSONB snapshot
- 로컬 전용 파일: 원본 XLSX template bytes는 IndexedDB에 보관

현재 publishable key는 브라우저에서 사용할 수 있는 공개 키입니다. Supabase secret 또는 service-role key를 소스에 추가하지 마세요.

앱은 로그인 없이 하나의 공유 작업공간을 읽고 수정합니다. URL을 아는 방문자는 상품·SKU·재고·입출고·발주·발주처 metadata를 모두 확인하고 변경할 수 있으며 편집자 식별 기능은 없습니다. 직접 테이블 접근은 차단하고 검증된 RPC만 공개하며, Supabase revision을 기준으로 충돌을 차단합니다. 원본 XLSX template bytes는 각 브라우저의 IndexedDB에만 남고 공유 상태로 전송되지 않습니다.

공유 상태가 방문자의 로컬 템플릿을 자동 삭제하지 못하도록 원격 `purge` 지시를 거부합니다. 브랜드 관찰 이력은 업로드당 500건, 공유 작업공간 전체 50,000건으로 제한하며 초과 요청은 작업공간 저장과 함께 롤백합니다.

GitHub Pages는 `main` 브랜치가 갱신될 때 `.github/workflows/pages.yml`을 통해 테스트 후 자동 배포됩니다.
