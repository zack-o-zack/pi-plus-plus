#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHANGELOG_PATH = join(ROOT, "CHANGELOG.md");
const PACKAGE_JSON_PATH = join(ROOT, "package.json");
const UNRELEASED_PLACEHOLDER = "- (add your changes here)";

// --- Exported helpers (testable) ---

export function extractUnreleased(changelog) {
  const match = changelog.match(
    /## Unreleased\n([\s\S]*?)(?=\n## |\n*$)/,
  );
  if (!match) return null;
  const body = match[1]
    .replace(UNRELEASED_PLACEHOLDER, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return body.replace(/^#{1,6}\s+.+$/gm, "").trim() ? body : null;
}

export function detectBump(body, currentVersion) {
  const [major, minor, patch] = currentVersion.split(".").map(Number);
  const hasBreaking = /\bbreaking\b/i.test(body) || /###\s+Breaking/i.test(body);
  const hasFeature = /###\s+Added/i.test(body) || /###\s+Changed/i.test(body);

  if (hasBreaking) return `${major + 1}.0.0`;
  if (hasFeature) return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export function release(changelogContent, currentVersion) {
  const body = extractUnreleased(changelogContent);
  if (!body) return null;

  const newVersion = detectBump(body, currentVersion);
  const today = new Date().toISOString().slice(0, 10);
  const versionHeading = `## ${newVersion} - ${today}`;

  const updatedChangelog = changelogContent.replace(
    /## Unreleased\n([\s\S]*?)(?=\n## |\n*$)/,
    `${versionHeading}\n\n${body}\n\n## Unreleased\n\n### Added\n\n${UNRELEASED_PLACEHOLDER}`,
  );

  return { newVersion, updatedChangelog };
}

// --- CLI entry point ---

function main() {
  const changelogContent = readFileSync(CHANGELOG_PATH, "utf-8");
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf-8"));
  const result = release(changelogContent, pkg.version);

  if (!result) {
    throw new Error("CHANGELOG.md has no Unreleased entries to release.");
  }

  const { newVersion, updatedChangelog } = result;

  // Update package.json
  pkg.version = newVersion;
  writeFileSync(PACKAGE_JSON_PATH, JSON.stringify(pkg, null, 2) + "\n");

  // Write updated CHANGELOG.md
  writeFileSync(CHANGELOG_PATH, updatedChangelog);

  console.log(`Released ${newVersion}`);
  console.log(`CHANGELOG.md updated and package.json bumped.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
