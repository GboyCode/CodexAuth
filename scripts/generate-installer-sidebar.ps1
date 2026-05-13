$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$outputPath = Join-Path $root "build\installer-sidebar.bmp"
$iconPath = Join-Path $root "src\ui\assets\codex-color.png"

$width = 164
$height = 314
$bitmap = [System.Drawing.Bitmap]::new($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppRgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)

try {
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

  $rect = [System.Drawing.Rectangle]::new(0, 0, $width, $height)
  $bg = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
    $rect,
    [System.Drawing.Color]::FromArgb(249, 251, 255),
    [System.Drawing.Color]::FromArgb(229, 234, 255),
    90
  )
  $graphics.FillRectangle($bg, $rect)
  $bg.Dispose()

  $accentRect = [System.Drawing.Rectangle]::new(0, 234, $width, 80)
  $accent = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
    $accentRect,
    [System.Drawing.Color]::FromArgb(154, 143, 255),
    [System.Drawing.Color]::FromArgb(66, 92, 255),
    90
  )
  $graphics.FillRectangle($accent, $accentRect)
  $accent.Dispose()

  $icon = [System.Drawing.Image]::FromFile($iconPath)
  try {
    $graphics.DrawImage($icon, 34, 28, 96, 96)
  } finally {
    $icon.Dispose()
  }

  $titleFont = [System.Drawing.Font]::new("Microsoft YaHei UI", 15, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Point)
  $subtitleFont = [System.Drawing.Font]::new("Microsoft YaHei UI", 11, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
  $smallFont = [System.Drawing.Font]::new("Microsoft YaHei UI", 8.5, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
  $center = [System.Drawing.StringFormat]::new()
  $center.Alignment = [System.Drawing.StringAlignment]::Center
  $center.LineAlignment = [System.Drawing.StringAlignment]::Center

  $ink = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(20, 24, 36))
  $muted = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(92, 105, 130))
  $white = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 255, 255))
  $switchText = -join ([char[]](0x8D26, 0x53F7, 0x5207, 0x6362))
  $localText = -join ([char[]](0x672C, 0x5730, 0x5B89, 0x5168, 0x5B58, 0x50A8))
  $usageText = -join ([char[]](0x5FEB, 0x901F, 0x5207, 0x6362, 0x0020, 0x00B7, 0x0020, 0x672C, 0x5730, 0x7528, 0x91CF))
  $windowsText = -join ([char[]](0x0057, 0x0069, 0x006E, 0x0064, 0x006F, 0x0077, 0x0073, 0x0020, 0x7248))

  $graphics.DrawString("CodexAuth", $titleFont, $ink, [System.Drawing.RectangleF]::new(0, 136, $width, 28), $center)
  $graphics.DrawString($switchText, $subtitleFont, $muted, [System.Drawing.RectangleF]::new(0, 166, $width, 24), $center)
  $graphics.DrawString($localText, $smallFont, $muted, [System.Drawing.RectangleF]::new(0, 196, $width, 20), $center)
  $graphics.DrawString($usageText, $smallFont, $white, [System.Drawing.RectangleF]::new(0, 248, $width, 20), $center)
  $graphics.DrawString($windowsText, $smallFont, $white, [System.Drawing.RectangleF]::new(0, 274, $width, 20), $center)

  $titleFont.Dispose()
  $subtitleFont.Dispose()
  $smallFont.Dispose()
  $center.Dispose()
  $ink.Dispose()
  $muted.Dispose()
  $white.Dispose()

  $bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Bmp)
  Write-Host "Generated $outputPath"
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}
