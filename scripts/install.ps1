param(
  [string]$Profile = "web",
  [switch]$Execute
)

$mode = if ($Execute) { "--execute" } else { "--plan" }
node (Join-Path $PSScriptRoot "..\tools\preflight.mjs") --plan
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node (Join-Path $PSScriptRoot "..\tools\install.mjs") --profile $Profile $mode
exit $LASTEXITCODE
