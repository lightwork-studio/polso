// app.json describes the TestFlight preview. The other variants change only the app's identity,
// so each installs side by side on one phone with its own Health permissions and data.
const variants = {
  development: { name: "Polso Dev", slug: "polso-dev", bundleIdentifier: "app.polso.dev" },
  preview: { name: "Polso Preview", slug: "polso-preview", bundleIdentifier: "app.polso.preview" },
  production: { name: "Polso", slug: "polso", bundleIdentifier: "app.polso.production" },
};

module.exports = ({ config }) => {
  const variant = process.env.POLSO_APP_VARIANT || "development";
  if (!Object.hasOwn(variants, variant)) {
    throw new Error(`Unknown Polso app variant: ${variant}`);
  }

  const { bundleIdentifier, ...app } = variants[variant];
  return {
    ...config,
    ...app,
    scheme: app.slug,
    ios: { ...config.ios, bundleIdentifier },
  };
};
