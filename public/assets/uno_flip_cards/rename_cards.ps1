# Rename uno cards from card_022.png–card_085.png
# Pattern: card_NNN.png → card_color_number.png
#
# Colors cycle (8): red, blue, green, yellow, teal, purple, pink, orange
# Numbers  (8):     two, three, four, five, six, seven, eight, nine
# card_022 = red_two, card_023 = blue_two … card_085 = orange_nine

$colors  = @('red','blue','green','yellow','teal','purple','pink','orange')
$numbers = @('two','three','four','five','six','seven','eight','nine')

$folder = $PSScriptRoot   # same folder as this script

for ($n = 22; $n -le 85; $n++) {
    $index      = $n - 22                       # 0..63
    $colorName  = $colors[$index % 8]           # cycles every 8
    $numberName = $numbers[[math]::Floor($index / 8)]  # changes every 8

    $oldName = "card_{0:D3}.png" -f $n          # card_022.png … card_085.png
    $newName = "card_${colorName}_${numberName}.png"

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
