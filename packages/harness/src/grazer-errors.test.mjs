import test from "node:test";
import assert from "node:assert/strict";

import {
  assertNoGrazerError,
  grazerErrorCode,
  isGrazerErrorCode,
  isGrazerUserControlError,
  resolveGrazerError,
} from "../dist/src/grazer-errors.js";

test("grazerErrorCode extracts the code from every error shape", () => {
  // resolved { error, error_code } object
  assert.equal(
    grazerErrorCode({ error: "nope", error_code: "GRAZER_UNAVAILABLE" }),
    "GRAZER_UNAVAILABLE",
  );
  // rejected / thrown Error carrying .error_code
  const err = Object.assign(new Error("boom"), {
    error_code: "GRAZER_SNAPSHOT_FAILED",
  });
  assert.equal(grazerErrorCode(err), "GRAZER_SNAPSHOT_FAILED");
  // bare known code string (e.g. onSendCDPMessageError second arg)
  assert.equal(
    grazerErrorCode("GRAZER_TASK_SPACE_USER_IN_CONTROL"),
    "GRAZER_TASK_SPACE_USER_IN_CONTROL",
  );
  // future code this build does not know about is still returned
  assert.equal(
    grazerErrorCode({ error_code: "GRAZER_FUTURE_CODE" }),
    "GRAZER_FUTURE_CODE",
  );
  // no code present
  assert.equal(grazerErrorCode({ error: "plain message" }), undefined);
  assert.equal(grazerErrorCode("plain message"), undefined);
});

test("isGrazerErrorCode narrows to known codes only", () => {
  assert.equal(isGrazerErrorCode("GRAZER_TASK_SPACE_NOT_FOUND"), true);
  assert.equal(isGrazerErrorCode("GRAZER_FUTURE_CODE"), false);
  assert.equal(isGrazerErrorCode(undefined), false);
});

test("resolveGrazerError overrides the native error message with the owned wording for an owned code", () => {
  const { code, message } = resolveGrazerError({
    error: "Task space 7 is not assigned to an agent.",
    error_code: "GRAZER_TASK_SPACE_INACTIVE",
  });
  assert.equal(code, "GRAZER_TASK_SPACE_INACTIVE");
  // Owned id-less guidance replaces the native "Task space 7 ..." text.
  assert.match(message, /taskSpaces\.claim\(id\)/);
  assert.doesNotMatch(message, /\b7\b/);
});

test("resolveGrazerError keeps the native error message for an unknown future code", () => {
  assert.deepEqual(
    resolveGrazerError({
      error: "Some build-specific detail",
      error_code: "GRAZER_FUTURE_CODE",
    }),
    {
      code: "GRAZER_FUTURE_CODE",
      message: "Some build-specific detail",
    },
  );
});

test("resolveGrazerError defers to the native error message for a code grazer does not own", () => {
  // GRAZER_OPERATION_FAILED is not owned: the client wording (e.g. which operation
  // failed) is more specific than any static line.
  assert.deepEqual(
    resolveGrazerError({
      error: "Failed to create task space",
      error_code: "GRAZER_OPERATION_FAILED",
    }),
    {
      code: "GRAZER_OPERATION_FAILED",
      message: "Failed to create task space",
    },
  );
});

test("resolveGrazerError falls back to the raw code for a bare non-owned code", () => {
  // grazer does not own NOT_SELECTED and a bare code carries no native error message,
  // so the stable code itself is the most specific thing to surface.
  assert.deepEqual(resolveGrazerError("GRAZER_TASK_SPACE_NOT_SELECTED"), {
    code: "GRAZER_TASK_SPACE_NOT_SELECTED",
    message: "GRAZER_TASK_SPACE_NOT_SELECTED",
  });
});

test("resolveGrazerError uses the id-less guidance block for a bare user-control code", () => {
  const { code, message } = resolveGrazerError("GRAZER_TASK_SPACE_USER_IN_CONTROL");
  assert.equal(code, "GRAZER_TASK_SPACE_USER_IN_CONTROL");
  assert.match(message, /taken control of this task space/);
  assert.match(message, /taskSpaces\.takeOver\(\)/);
  assert.doesNotMatch(message, /<id>/);
});

test("resolveGrazerError falls back to the raw code, then a generic message", () => {
  assert.deepEqual(resolveGrazerError({ error_code: "GRAZER_FUTURE_CODE" }), {
    code: "GRAZER_FUTURE_CODE",
    message: "GRAZER_FUTURE_CODE",
  });
  assert.deepEqual(resolveGrazerError({}), {
    code: undefined,
    message: "Unknown grazer error",
  });
});

test("isGrazerUserControlError keys on the stable code, not wording", () => {
  assert.equal(
    isGrazerUserControlError(
      Object.assign(new Error("anything at all"), {
        error_code: "GRAZER_TASK_SPACE_USER_IN_CONTROL",
      }),
    ),
    true,
  );
  // wording that mentions user control but lacks the code is not a match
  assert.equal(
    isGrazerUserControlError(new Error("the user is controlling this")),
    false,
  );
  assert.equal(
    isGrazerUserControlError({ error_code: "GRAZER_SNAPSHOT_FAILED" }),
    false,
  );
});

test("assertNoGrazerError resolves the message via the code and attaches error_code", () => {
  try {
    assertNoGrazerError(
      {
        error: "Task space not selected",
        error_code: "GRAZER_TASK_SPACE_NOT_SELECTED",
      },
      "listTabs",
    );
    assert.fail("expected assertNoGrazerError to throw");
  } catch (err) {
    assert.equal(err.message, "listTabs: Task space not selected");
    assert.equal(err.error_code, "GRAZER_TASK_SPACE_NOT_SELECTED");
  }
});

test("assertNoGrazerError omits the prefix when no op is given", () => {
  try {
    assertNoGrazerError({
      error: "The task space is inactive: 10",
      error_code: "GRAZER_TASK_SPACE_INACTIVE",
    });
    assert.fail("expected assertNoGrazerError to throw");
  } catch (err) {
    // No op given, so no "<op>: " prefix — the owned block starts the message.
    assert.match(err.message, /^The user has taken control/);
    assert.match(err.message, /taskSpaces\.claim\(id\)/);
    assert.doesNotMatch(err.message, /\b10\b/);
    assert.equal(err.error_code, "GRAZER_TASK_SPACE_INACTIVE");
  }
});

test("assertNoGrazerError passes through results with no error", () => {
  const ok = { tabs: [] };
  assert.equal(assertNoGrazerError(ok, "listTabs"), ok);
});
