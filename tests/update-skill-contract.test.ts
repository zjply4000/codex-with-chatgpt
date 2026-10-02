import fs from "node:fs";
import { describe, expect, it } from "vitest";

const skill = fs.readFileSync(new URL("../skill/SKILL.md", import.meta.url), "utf8");
const daily = skill.slice(skill.indexOf("## Daily update check"), skill.indexOf("## Workflow: update"));
const update = skill.slice(skill.indexOf("## Workflow: update"), skill.indexOf("## Connection choice"));

describe("safe automatic update Skill contract", () => {
  it("contains no automatic stash command", () => {
    expect(skill).not.toMatch(/git\s+stash\b/);
    expect(update).toMatch(/Never stash/i);
  });
  it("skips every unsafe development state and continues the user's original task", () => {
    for (const reason of ["working_tree_dirty", "local_ahead", "diverged", "no_upstream", "detached"]) expect(daily).toContain(reason);
    expect(daily).toMatch(/continue.*original task/i);
  });
  it("requires a fresh clean behind-only preflight before ff-only pull", () => {
    expect(update).toContain("--force --json");
    expect(update).toContain("autoUpdateEligible");
    expect(update).toMatch(/ahead.*0/);
    expect(update).toMatch(/behind.*>.*0/);
    expect(update).toMatch(/clean/i);
    expect(update.indexOf("autoUpdateEligible")).toBeLessThan(update.indexOf("git pull --ff-only"));
    expect(update).toMatch(/pull fails.*stop.*update/is);
  });
  it("retains the configured upstream and branch-aware cache rules", () => {
    expect(daily).toMatch(/configured upstream/i);
    expect(daily).toMatch(/checkout.*branch.*upstream.*HEAD/is);
    expect(daily).toMatch(/dirty.*cache/is);
  });
  it("preserves explicit Adopt validation and controlled recovery boundaries", () => {
    expect(skill).toContain("### Adopt existing Project chat (explicit context adoption only)");
    expect(skill).toContain("Failure, inability to verify, or a different");
    expect(skill).toContain("Never scan historical `[C2C]` messages");
    expect(skill).toContain("## Workflow: bridge runtime repair (untrusted live instance)");
    expect(skill).toContain("c2c bridge recover --json");
    expect(skill).toContain("Never bypass a blocked plan");
  });
});
