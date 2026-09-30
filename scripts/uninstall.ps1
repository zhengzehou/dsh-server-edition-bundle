param(
  [string]$Profile = "web",
  [switch]$Execute,
  [switch]$PurgeData,
  [switch]$Confirm
)

$mode = if ($Execute) { "--execute" } else { "--plan" }
$args = @("--profile", $Profile, $mode)
if ($PurgeData) { $args += "--purge-data" }
if ($Confirm) { $args += "--confirm" }
node (Join-Path $PSScriptRoot "..\tools\uninstall.mjs") @args
exit $LASTEXITCODE
