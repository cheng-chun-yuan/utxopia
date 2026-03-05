import { describe, it, expect } from "vitest";
import { ApiError } from "../errors";

describe("ApiError", () => {
  describe("constructor", () => {
    it("creates error with message only", () => {
      const error = new ApiError("Something went wrong");
      expect(error.message).toBe("Something went wrong");
      expect(error.name).toBe("ApiError");
      expect(error.code).toBeUndefined();
      expect(error.statusCode).toBeUndefined();
      expect(error.details).toBeUndefined();
    });

    it("creates error with all properties", () => {
      const error = new ApiError("Not found", "NOT_FOUND", 404, "Resource does not exist");
      expect(error.message).toBe("Not found");
      expect(error.code).toBe("NOT_FOUND");
      expect(error.statusCode).toBe(404);
      expect(error.details).toBe("Resource does not exist");
    });

    it("is an instance of Error", () => {
      const error = new ApiError("Test");
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(ApiError);
    });
  });

  describe("fromResponse", () => {
    it("creates ApiError from response with error message", () => {
      const error = ApiError.fromResponse({ error: "Invalid request" }, 400);
      expect(error.message).toBe("Invalid request");
      expect(error.statusCode).toBe(400);
    });

    it("creates ApiError with code and details", () => {
      const error = ApiError.fromResponse(
        { error: "Unauthorized", code: "AUTH_REQUIRED", details: "Token expired" },
        401
      );
      expect(error.message).toBe("Unauthorized");
      expect(error.code).toBe("AUTH_REQUIRED");
      expect(error.statusCode).toBe(401);
      expect(error.details).toBe("Token expired");
    });

    it("uses HTTP status as fallback message", () => {
      const error = ApiError.fromResponse({}, 500);
      expect(error.message).toBe("HTTP 500");
      expect(error.statusCode).toBe(500);
    });

    it("handles various HTTP status codes", () => {
      expect(ApiError.fromResponse({ error: "Bad Request" }, 400).statusCode).toBe(400);
      expect(ApiError.fromResponse({ error: "Forbidden" }, 403).statusCode).toBe(403);
      expect(ApiError.fromResponse({ error: "Not Found" }, 404).statusCode).toBe(404);
      expect(ApiError.fromResponse({ error: "Server Error" }, 500).statusCode).toBe(500);
    });
  });

  describe("fromUnknown", () => {
    it("returns same error if already ApiError", () => {
      const original = new ApiError("Original", "CODE", 400);
      const result = ApiError.fromUnknown(original);
      expect(result).toBe(original);
    });

    it("wraps regular Error", () => {
      const regularError = new Error("Regular error message");
      const result = ApiError.fromUnknown(regularError);
      expect(result).toBeInstanceOf(ApiError);
      expect(result.message).toBe("Regular error message");
    });

    it("handles string errors", () => {
      const result = ApiError.fromUnknown("string error");
      expect(result).toBeInstanceOf(ApiError);
      expect(result.message).toBe("Unknown error occurred");
    });

    it("handles null/undefined", () => {
      expect(ApiError.fromUnknown(null).message).toBe("Unknown error occurred");
      expect(ApiError.fromUnknown(undefined).message).toBe("Unknown error occurred");
    });

    it("handles objects", () => {
      const result = ApiError.fromUnknown({ foo: "bar" });
      expect(result.message).toBe("Unknown error occurred");
    });
  });
});
