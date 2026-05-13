const fs = require("node:fs");
const path = require("node:path");

const templatePath = path.join(
  __dirname,
  "..",
  "node_modules",
  "app-builder-lib",
  "templates",
  "nsis",
  "assistedInstaller.nsh"
);

const original = fs.readFileSync(templatePath, "utf8");
const marker = "# CodexAuth custom directory behavior";

if (!original.includes(marker)) {
  const from = `    # sanitize the MUI_PAGE_DIRECTORY result to make sure it has a application name sub-folder
    Function instFilesPre
      \${StrContains} $0 "\${APP_FILENAME}" $INSTDIR
      \${If} $0 == ""
        StrCpy $INSTDIR "$INSTDIR\\\${APP_FILENAME}"
      \${endIf}
    FunctionEnd`;

  const to = `    ${marker}
    # If the user selects a drive root such as D:\\\\, install into D:\\\\\${APP_FILENAME}.
    # If the user selects or types a folder, install directly into that folder.
    Function instFilesPre
      StrLen $1 $INSTDIR
      IntOp $1 $1 - 1
      StrCpy $2 $INSTDIR 1 $1
      StrLen $3 $INSTDIR
      \${If} $2 == "\\\\"
      \${AndIf} $3 == 3
        StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
      \${endIf}
    FunctionEnd`;

  if (!original.includes(from)) {
    throw new Error("NSIS template shape changed; cannot patch directory behavior.");
  }
  fs.writeFileSync(templatePath, original.replace(from, to));
}
