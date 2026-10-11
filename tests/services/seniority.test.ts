import { describe, expect, it } from "vitest";
import {
  isClearlySeniorTitle,
  requestsSeniorRoles,
} from "../../src/services/seniority.js";

describe("isClearlySeniorTitle", () => {
  it("recognises explicit senior and sr roles", () => {
    expect(isClearlySeniorTitle("Senior Software Developer")).toBe(true);
    expect(isClearlySeniorTitle("Senior React Developer")).toBe(true);
    expect(isClearlySeniorTitle("Sr. Backend Engineer")).toBe(true);
    expect(isClearlySeniorTitle("Sr DevOps Engineer")).toBe(true);
  });

  it("recognises lead roles only when tied to a development noun", () => {
    expect(isClearlySeniorTitle("Lead Full Stack Software Developer")).toBe(true);
    expect(isClearlySeniorTitle("Lead Software Developer")).toBe(true);
    expect(isClearlySeniorTitle("Lead QA Engineer")).toBe(true);
    expect(isClearlySeniorTitle("Tech Lead")).toBe(true);
    expect(isClearlySeniorTitle("Team Lead Developer")).toBe(true);
    expect(isClearlySeniorTitle("Lead Data Engineer")).toBe(true);
  });

  it("recognises principal, staff, head, manager and director titles", () => {
    expect(isClearlySeniorTitle("Principal Engineer")).toBe(true);
    expect(isClearlySeniorTitle("Principal Software Developer")).toBe(true);
    expect(isClearlySeniorTitle("Staff Software Engineer")).toBe(true);
    expect(isClearlySeniorTitle("Staff Engineer")).toBe(true);
    expect(isClearlySeniorTitle("Head of Engineering")).toBe(true);
    expect(isClearlySeniorTitle("Engineering Manager")).toBe(true);
    expect(isClearlySeniorTitle("Development Manager")).toBe(true);
    expect(isClearlySeniorTitle("Director of Engineering")).toBe(true);
    expect(isClearlySeniorTitle("Technical Director")).toBe(true);
    expect(isClearlySeniorTitle("Manager of Software Development")).toBe(true);
  });

  it("recognises chief, C-suite and architect-level roles", () => {
    expect(isClearlySeniorTitle("Chief Technology Officer")).toBe(true);
    expect(isClearlySeniorTitle("CTO")).toBe(true);
    expect(isClearlySeniorTitle("VP Engineering")).toBe(true);
    expect(isClearlySeniorTitle("Vice President of Engineering")).toBe(true);
    expect(isClearlySeniorTitle("Solutions Architect")).toBe(true);
    expect(isClearlySeniorTitle("Principal Backend Architect")).toBe(true);
  });

  it("does not treat false-positive seniority terms as senior", () => {
    expect(isClearlySeniorTitle("Lead Generation Specialist")).toBe(false);
    expect(isClearlySeniorTitle("Sales Lead")).toBe(false);
    expect(isClearlySeniorTitle("Staffing Consultant")).toBe(false);
    expect(isClearlySeniorTitle("Head of Sales")).toBe(false);
    expect(isClearlySeniorTitle("Principal Accountant")).toBe(false);
    expect(isClearlySeniorTitle("United States - Software Developer")).toBe(false);
  });

  it("never excludes legitimate junior or entry-level roles", () => {
    expect(isClearlySeniorTitle("Graduate Software Developer")).toBe(false);
    expect(isClearlySeniorTitle("Junior React Developer")).toBe(false);
    expect(isClearlySeniorTitle("Software Development Apprenticeship")).toBe(false);
    expect(isClearlySeniorTitle("Industrial Placement Software Engineer")).toBe(false);
    expect(isClearlySeniorTitle("Trainee Web Developer")).toBe(false);
    expect(isClearlySeniorTitle("QA Tester")).toBe(false);
    expect(isClearlySeniorTitle("Test Automation Engineer")).toBe(false);
  });
});

describe("requestsSeniorRoles", () => {
  it("returns true when keywords explicitly ask for senior roles", () => {
    expect(requestsSeniorRoles(["senior", "software", "developer"])).toBe(true);
    expect(requestsSeniorRoles(["engineering manager"])).toBe(true);
    expect(requestsSeniorRoles(["lead"])).toBe(true);
    expect(requestsSeniorRoles(["principal engineer"])).toBe(true);
  });

  it("returns false for junior/default keywords or no keywords", () => {
    expect(requestsSeniorRoles(["software", "developer"])).toBe(false);
    expect(requestsSeniorRoles(["graduate"])).toBe(false);
    expect(requestsSeniorRoles(undefined)).toBe(false);
    expect(requestsSeniorRoles([])).toBe(false);
  });
});