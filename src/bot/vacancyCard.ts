import type { Vacancy, EvidenceState } from "../models/vacancy.js";
import { deriveEvidenceState, evidenceStateLabel } from "../services/sponsorship.js";
import { validateApplicationUrl } from "../services/applicationUrl.js";

/** Escape text for Telegram MarkdownV2. */
export function escapeMd(text: string): string {
  return text.replace(/[_*[\]()~>#+\-=|{}.!`\\]/g, "\\$&");
}

export type ResultGroup = "confirmed" | "alternative" | "not_offered";

export function groupFor(vacancy: Vacancy): ResultGroup {
  if (vacancy.vacancySponsorshipStatus === "confirmed") return "confirmed";
  if (vacancy.vacancySponsorshipStatus === "not_offered") return "not_offered";
  return "alternative";
}

export function sponsorshipLabel(vacancy: Vacancy, group: ResultGroup): string {
  if (group === "confirmed") return evidenceStateLabel("vacancy_sponsorship_confirmed");
  if (group === "alternative") return evidenceStateLabel(deriveEvidenceState(vacancy));
  return evidenceStateLabel("sponsorship_unavailable");
}

/**
 * The stored employer-register outcome, falling back to the legacy positive
 * flag for older vacancy data that predates `employerRegisterStatus`.
 */
export function employerRegisterStatusOf(
  vacancy: Vacancy,
): Vacancy["employerRegisterStatus"] {
  if (vacancy.employerRegisterStatus !== undefined) return vacancy.employerRegisterStatus;
  if (vacancy.employerSponsorshipVerified === true) return "verified";
  return undefined;
}

/**
 * A concise employer-register line, kept separate from the vacancy-level
 * sponsorship status. It states the employer's licence capability only and never
 * implies the vacancy offers sponsorship (and `not_found` never means the
 * employer is unlicensed).
 */
export function employerRegisterLine(vacancy: Vacancy): string | null {
  switch (employerRegisterStatusOf(vacancy)) {
    case "verified": {
      const entry = vacancy.employerVerificationTarget ?? vacancy.employer;
      const updated = vacancy.sponsorRegisterUpdatedAt
        ? `, register updated ${vacancy.sponsorRegisterUpdatedAt}`
        : "";
      return `Employer register: LICENSED SPONSOR - matched "${entry}" on the official register${updated}.`;
    }
    case "not_found":
      return "Employer register: no exact match on the official register - this does NOT prove the employer is unlicensed (legal/trading names can differ).";
    case "unavailable":
      return "Employer register: could not be checked (register unavailable) - no conclusion either way.";
    case "not_checked":
      return "Employer register: not checked - advertised by a recruitment agency and the hiring employer was not identified.";
    default:
      return null;
  }
}

/**
 * A single vacancy card shared by `/search` replies and scheduled alerts, so a
 * notification can never present sponsorship differently from the interactive
 * command.
 */
export function formatVacancy(vacancy: Vacancy, group: ResultGroup): string {
  const parts: string[] = [];
  parts.push(`*${escapeMd(vacancy.title)}*`);
  parts.push(escapeMd(`Employer: ${vacancy.employer}`));
  parts.push(
    escapeMd(
      `Location: ${vacancy.location}${
        vacancy.locationEligibility ? ` (UK eligibility: ${vacancy.locationEligibility})` : ""
      }`,
    ),
  );
  if (vacancy.salary) parts.push(escapeMd(`Salary: ${vacancy.salary}`));
  parts.push(escapeMd(sponsorshipLabel(vacancy, group)));
  const registerLine = employerRegisterLine(vacancy);
  if (registerLine !== null) parts.push(escapeMd(registerLine));

  if (group === "confirmed" && vacancy.sponsorshipEvidence) {
    parts.push(escapeMd(`Evidence: ${vacancy.sponsorshipEvidence}`));
  } else if (group === "alternative") {
    if (vacancy.fallbackReason) parts.push(escapeMd(`Why shown: ${vacancy.fallbackReason}`));
    const note =
      vacancy.employerSponsorshipVerified === true
        ? "Note: an authoritative UK register confirms this employer is licensed to sponsor, but the vacancy itself does not confirm sponsorship for this role."
        : vacancy.employerSponsorLicence === "yes"
          ? "Note: the listing mentions a sponsor licence, but this does not confirm sponsorship for this specific role."
          : "Note: this listing contains no sponsorship evidence. Ask the employer whether they can sponsor this role.";
    parts.push(escapeMd(note));
  } else if (vacancy.sponsorshipEvidence) {
    parts.push(escapeMd(`Evidence: ${vacancy.sponsorshipEvidence}`));
  }

  if (vacancy.matchScore !== undefined) parts.push(escapeMd(`Match: ${vacancy.matchScore}/100`));
  const application = validateApplicationUrl(vacancy.applicationUrl);
  if (application.status === "direct" && application.url !== undefined) {
    parts.push(escapeMd(`Apply: ${application.url}`));
  } else {
    const note =
      vacancy.applicationUrlNote ?? application.note ?? "no direct listing URL was provided";
    parts.push(escapeMd(`Apply: link unavailable (${note})`));
  }
  if (vacancy.source) parts.push(escapeMd(`Source: ${vacancy.source}`));
  return parts.join("\n");
}

/** The evidence state a vacancy displays, for callers that need it directly. */
export function vacancyEvidenceState(vacancy: Vacancy): EvidenceState {
  return vacancy.evidenceState ?? deriveEvidenceState(vacancy);
}
