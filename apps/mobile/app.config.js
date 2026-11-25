// app.json describes the TestFlight preview. The other variants change only the app's identity,
// so each installs side by side on one phone with its own Health permissions and data.
// Each variant builds on EAS under its own project once it has one; forks set their own.
const EXPO_OWNER = "webertim";
const variants = {
  development: {
    name: "Polso Dev",
    slug: "polso-dev",
    bundleIdentifier: "app.polso.dev",
    projectId: "e700bfb2-1592-4d37-a382-6055bff6b4b7",
  },
  preview: { name: "Polso Preview", slug: "polso-preview", bundleIdentifier: "app.polso.preview" },
  production: { name: "Polso", slug: "polso", bundleIdentifier: "app.polso.production" },
};

module.exports = ({ config }) => {
  const variant = process.env.POLSO_APP_VARIANT ?? "development";
  if (!Object.hasOwn(variants, variant)) {
    throw new Error(`Unknown Polso app variant: ${variant}`);
  }

  const { bundleIdentifier, projectId, ...app } = variants[variant];
  return {
    ...config,
    ...app,
    scheme: app.slug,
    ios: { ...config.ios, bundleIdentifier },
    ...(projectId && {
      owner: EXPO_OWNER,
      extra: { ...config.extra, eas: { projectId } },
    }),
  };
};
