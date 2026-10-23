const { createDefaultPreset } = require("ts-jest");

const tsJestTransformCfg = createDefaultPreset().transform;

/** @type {import("jest").Config} **/
module.exports = {
  testEnvironment: "node",
  watchman: false,
  maxWorkers: 1,
  testTimeout: 10000,
  transform: {
    ...tsJestTransformCfg,
  },
};