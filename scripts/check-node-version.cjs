// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const requiredNodeVersion = "^22.23.4 || ^24.22.1 || >=26.12.1";

function isPatchedNodeVersion(version) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) {
    return false;
  }

  const [major, minor, patch] = match.slice(1).map(Number);
  const minimum = { 22: [23, 4], 24: [22, 1], 26: [12, 1] }[major];
  return (
    major > 26 ||
    (minimum !== undefined && (minor > minimum[0] || (minor === minimum[0] && patch >= minimum[1])))
  );
}

if (require.main === module) {
  if (!isPatchedNodeVersion(process.versions.node)) {
    console.error(
      `Node.js ${process.versions.node} does not meet the October 21, 2026 security baseline. ` +
        `Required: ${requiredNodeVersion}. Upgrade the selected Node.js runtime.`,
    );
    process.exitCode = 1;
  } else {
    console.log(`Node.js ${process.versions.node} meets the October 21, 2026 security baseline.`);
  }
}

module.exports = { isPatchedNodeVersion, requiredNodeVersion };
