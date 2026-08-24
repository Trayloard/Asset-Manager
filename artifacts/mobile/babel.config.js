module.exports = function (api) {
  api.cache(true);
<<<<<<< HEAD
  return {
    presets: [["babel-preset-expo", { unstable_transformImportMeta: true }]],
=======
  const isTest = process.env.NODE_ENV === "test";
  return {
    presets: [
      [
        "babel-preset-expo",
        {
          unstable_transformImportMeta: true,
          worklets: isTest ? false : undefined,
          reanimated: isTest ? false : undefined,
        },
      ],
    ],
>>>>>>> origin/main
  };
};
