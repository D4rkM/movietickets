/** Unit tests: colocated *.spec.ts next to source. */
module.exports = {
  rootDir: "src",
  moduleFileExtensions: ["js", "json", "ts"],
  testRegex: ".spec.ts$",
  transform: {
    "^.+\\.ts$": "ts-jest",
  },
  collectCoverage: true,
  collectCoverageFrom: [
    "**/*.(t|j)s",
    "!**/*.spec.ts",
    "!**/*.module.ts",
    "!**/*.dto.ts",
    "!**/*.type.ts",
    "!**/main.ts",
    "!**/db/schema.ts",
    "!**/db/migrate.ts",
    "!**/types/**",
  ],
  coverageDirectory: "../coverage",
  coverageThreshold: {
    global: {
      branches: 75,
      functions: 75,
      lines: 75,
      statements: 75,
    },
  },
  testEnvironment: "node",
};
