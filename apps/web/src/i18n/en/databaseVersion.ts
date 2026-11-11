// English strings: databaseVersion. See ../t.ts for keys, placeholders and plurals.
// The Version card on a database's Settings tab and its confirm dialog.

export default {
  title: "Version",
  description: "The engine version and image this database runs. A change deploys it on the same data.",
  current: "Runs",
  // A tag that names no release (latest, a digest): the image says what runs.
  currentImage: "{engine} ({image})",
  image: "Image",
  logins: "Logins",
  nativeOn: "Old mysql_native_password logins are on",
  nativeSwitch: "Keep old mysql_native_password logins working",
  nativeSwitchHint: "Runs MySQL {version} with --mysql-native-password=ON. Applying restarts the database on the image it runs.",
  nativeApply: "Apply",
  native: {
    titleOn: "Turn old mysql_native_password logins on?",
    titleOff: "Turn old mysql_native_password logins off?",
    bodyOn:
      "MySQL {version} starts with --mysql-native-password=ON, so accounts made with mysql_native_password sign in again. Later deploys and updates keep it.",
    bodyOff:
      "MySQL {version} starts without --mysql-native-password=ON. The running database is checked for accounts that sign in with mysql_native_password first: if there are any, nothing changes.",
  },
  changeTo: "Change to",
  pick: "Pick a version",
  noChoice: "No other version is available for this database.",
  change: "Change version",
  anotherImage: "Use another image",
  newest: "{version} (newest)",
  kind: {
    current: "current",
    patch: "update to {image}",
    upgrade: "upgrade",
    major: "major upgrade",
    downgrade: "older",
  },
  // Under a catalog version the change takes a risk for: the dialog says more.
  riskNote: {
    downgrade: "Older than what runs: newer data files may not open on it",
    olderImage: "Older than what runs: newer data files may not open on it",
    postgresMajor: "A major jump: Postgres does not open another major's data files in place",
    dataPath: "Keeps its data in another folder",
    patchOnly: "Takes patch updates only",
    oneStep: "Skips a version",
    otherLine: "Not tested by Seylo",
    postgresBase: "Another base system: text indexes may need REINDEX",
    floatingTag: "Seylo cannot tell which release runs",
    digest: "Seylo cannot tell which release runs",
  },
  deploying: "Deploying {image}",
  viewLog: "View log",
  pending: "The change to {pending} did not finish, so the database still runs {image}. Pick it again to retry, or stay on {image}.",
  customLabel: "Image",
  imageHint: "Any tag or digest of {repo}, like {image}. Not tested by Seylo.",
  confirm: {
    titlePatch: "Update to {image}?",
    titleLine: "Change {engine} to {version}?",
    stay: "Stay on {image}?",
    titleImage: "Run another image of {engine}?",
    imageSame: "The database runs {image}. Give the image to run instead.",
    restart: "The database restarts on {image}: a short outage while it starts.",
    undo: "This cannot be undone. Older versions cannot read the upgraded data files; going back means restoring a backup into a new database.",
    mongoFcv: "MongoDB's feature compatibility version is set to {version} on the running database first. If that fails, nothing changes.",
    mysqlNative:
      "MySQL {version} has mysql_native_password logins off. The running database is checked for accounts that sign in with it first: if there are any, nothing changes until you pick what to do with them.",
    riskTitle: "What can go wrong",
    // One line for each risk the panel found, then what protects the data.
    risk: {
      downgrade: "{image} is older than what runs. Data files a newer version wrote may not open on it.",
      olderImage: "{image} is older than what runs. Data files a newer release wrote may not open on it.",
      postgresMajor:
        "A major jump: Postgres does not open another major's data files without pg_upgrade or a dump and restore, which do not run here. It will most likely not start.",
      dataPath:
        "This version keeps its data in another folder. Seylo runs it on the folder of the data that runs, so it will most likely not start.",
      patchOnly: "{engine} takes patch updates only: another version may not read the data files.",
      oneStep: "It skips a version: {engine} upgrades one version at a time, so it may refuse the data files.",
      otherLine: "Not tested by Seylo: {image} is {engine} {version}, which Seylo does not offer.",
      otherLineRuns: "Not tested by Seylo: {image}, which runs, is {engine} {version}, which Seylo does not offer.",
      postgresBase: "Another base system: its C library may sort text in another order, so indexes on text columns may need REINDEX.",
      floatingTag:
        "{image} is not an exact release: it moves to each new {engine} {release} release, so the release behind it can change on the next deploy, and Seylo cannot check it against what runs.",
      floatingTagAny:
        "{image} is not an exact release: a tag without a full release number moves to each new release, so the release behind it can change on the next deploy, and Seylo cannot check it against what runs.",
      floatingTagRuns: "{image}, which runs, is not an exact release: Seylo cannot tell which release runs, so it cannot check the change.",
      digest: "A digest does not show which release it is, so Seylo cannot check the change.",
    },
    riskMongo:
      "MongoDB may refuse data whose feature compatibility version it does not support: Seylo sets it only for a one-step upgrade between its catalog versions.",
    riskBack: "If the new version never gets healthy, the old container comes back on the same data.",
    understand: "I understand",
    nativeUsers: {
      one: "This account signs in with mysql_native_password, which MySQL {version} has off, so it could not sign in after the change:",
      other:
        "These {count} accounts sign in with mysql_native_password, which MySQL {version} has off, so they could not sign in after the change:",
    },
    nativeMore: "and {count} more",
    nativeFix:
      "Switch them to caching_sha2_password first (ALTER USER 'user'@'host' IDENTIFIED WITH caching_sha2_password BY '…', which needs each account's password), or keep their logins working.",
    keepNative: "Keep mysql_native_password logins working in {version}",
    keepNativeHint:
      "MySQL {version} starts with --mysql-native-password=ON, and later updates keep it. Switching the accounts is the lasting fix: MySQL 9 has no mysql_native_password.",
    backupTitle: "Backup",
    backupFresh: "Last backup {when}.",
    backupMissing: "No successful backup from the last 24 hours.",
    backupNone: "This database has no backup schedule yet.",
    setUpBackups: "Set up backups",
    backUpNow: "Back up now",
    backingUp: "Backing up…",
    backupDone: "Backup finished {when}.",
    backupFailed: "The backup failed: {error}",
    withoutBackup: "Change without a backup",
    button: "Change version",
    buttonPatch: "Update",
    done: "Deploying {image}.",
  },
};
