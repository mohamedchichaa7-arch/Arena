# Rename card_020.png – card_091.png
#
# 72 cards = 9 numbers × 8 cards (4 filled + 4 empty)
# Colors:  red, blue, green, yellow
# Numbers: two, three, four, five, six, seven, eight, nine, zero
#
# Index within a group of 8:
#   0-3  → color_number_filled
#   4-7  → color_number   (empty, no suffix)

$colors  = @('red','blue','green','yellow')
$numbers = @('two','three','four','five','six','seven','eight','nine','zero')
$folder  = $PSScriptRoot

for ($n = 20; $n -le 91; $n++) {
    $index      = $n - 20                              # 0..71
    $numName    = $numbers[[math]::Floor($index / 8)]  # changes every 8
    $posInGroup = $index % 8                           # 0..7
    $colorName  = $colors[$posInGroup % 4]             # 0-3 filled, 4-7 empty
    $filled     = $posInGroup -lt 4

    $newName = if ($filled) {
        "card_${colorName}_${numName}_filled.png"
    } else {
        "card_${colorName}_${numName}.png"
    }

    $oldName = "card_{0:D3}.png" -f $n
    $oldPath = Join-Path $folder $oldName
    $newPath = Join-Path $folder $newName

    if (Test-Path $oldPath) {
        Rename-Item -Path $oldPath -NewName $newName
        Write-Host "$oldName  →  $newName"
    } else {
        Write-Warning "Not found: $oldName"
    }
}

Write-Host "`nDone."
