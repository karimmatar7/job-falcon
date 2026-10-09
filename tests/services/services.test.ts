import { describe, expect, it } from "vitest";
import { ServiceNotImplementedError } from "../../src/services/errors.js";
import { PlaceholderVacancyVerificationService } from "../../src/services/vacancyVerification.js";
import { PlaceholderDuplicateDetectionService } from "../../src/services/duplicateDetection.js";

describe("Phase 2 service placeholders", () => {
  it("vacancy verification throws a clear not-implemented error", async () => {
    const service = new PlaceholderVacancyVerificationService();
    await expect(service.verify({ id: "1", url: "https://example.com" })).rejects.toBeInstanceOf(
      ServiceNotImplementedError,
    );
  });

  it("duplicate detection throws a clear not-implemented error", async () => {
    const service = new PlaceholderDuplicateDetectionService();
    await expect(service.findDuplicates([])).rejects.toBeInstanceOf(ServiceNotImplementedError);
  });
});
