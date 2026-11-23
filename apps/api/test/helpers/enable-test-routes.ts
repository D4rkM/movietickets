// Jest setupFile: the integration suites use the mocked POST /bookings/:id/confirm,
// which only exists with this flag (docs/flows/test-routes/spec.md).
process.env.ENABLE_TEST_ROUTES = "true";
