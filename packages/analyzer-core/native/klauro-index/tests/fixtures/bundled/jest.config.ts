export default {
  moduleNameMapper: {
    "^spec/(.*)$": "<rootDir>/test/$1",
    "^lodash-es$": "<rootDir>/node_modules/lodash",
    "\\.(css|less)$": "<rootDir>/test/styles.js",
  },
  testEnvironment: "node",
};
