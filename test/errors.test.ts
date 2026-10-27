import { expect, test } from "vitest";
import { errorDetail } from "../src/errors.js";

test("diagnostics preserve the cause while removing URL and header credentials", () => {
  const detail = errorDetail(new Error('401 Unauthorized https://user:pass@example.invalid/v1?token=query-secret&key=plain-secret&x%2Dapi%2Dkey=encoded-secret&model=one Authorization: Bearer header-secret; {"refresh_token":"refresh-secret"}'));
  expect(detail).toContain("401 Unauthorized");
  expect(detail).toContain("model=one");
  for (const secret of ["user:pass", "query-secret", "plain-secret", "encoded-secret", "header-secret", "refresh-secret"]) expect(detail).not.toContain(secret);
});

test("nested network failures retain their cause without dumping arbitrary error data", () => {
  const detail = errorDetail(new Error("fetch failed", { cause: new Error("connect ECONNREFUSED token=private-value") }));
  expect(detail).toContain("ECONNREFUSED");
  expect(detail).not.toContain("private-value");
});
