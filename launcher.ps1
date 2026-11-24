Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$reader = Join-Path $root 'usermode.exe'
$node = Join-Path $root 'runtime\node.exe'
$server = Join-Path $root 'webapp\ws\app.js'
$url = 'http://127.0.0.1:5173'
$script:children = @()
$form = New-Object Windows.Forms.Form
$form.Text = 'CS2 Radar Desktop'
$form.Size = New-Object Drawing.Size(420,220)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$status = New-Object Windows.Forms.Label
$status.Text = 'Gotowy. Uruchom CS2, a następnie radar.'
$status.Location = New-Object Drawing.Point(22,20)
$status.Size = New-Object Drawing.Size(370,42)
$form.Controls.Add($status)
$start = New-Object Windows.Forms.Button
$start.Text = 'Uruchom radar'
$start.Location = New-Object Drawing.Point(22,75)
$start.Size = New-Object Drawing.Size(175,45)
$form.Controls.Add($start)
$stop = New-Object Windows.Forms.Button
$stop.Text = 'Zatrzymaj'
$stop.Location = New-Object Drawing.Point(215,75)
$stop.Size = New-Object Drawing.Size(175,45)
$form.Controls.Add($stop)
$start.Add_Click({
    if (-not (Get-Process cs2 -ErrorAction SilentlyContinue)) {
        [Windows.Forms.MessageBox]::Show('Najpierw uruchom Counter-Strike 2.', 'CS2 Radar') | Out-Null
        return
    }
    foreach ($path in @($reader,$node,$server)) {
        if (-not (Test-Path $path)) {
            [Windows.Forms.MessageBox]::Show("Brakuje pliku: $path`nSprawdz instrukcje budowania.", 'Brak komponentu') | Out-Null
            return
        }
    }
    if ($script:children.Count -gt 0) { return }
    try {
        $script:children += Start-Process -FilePath $node -ArgumentList @($server) -WorkingDirectory (Join-Path $root 'webapp') -PassThru -WindowStyle Hidden
        $script:children += Start-Process -FilePath $reader -WorkingDirectory $root -PassThru
        Start-Process $url
        $status.Text = 'Radar uruchomiony. Otworzono przegladarke.'
    } catch {
        $status.Text = "Blad: $($_.Exception.Message)"
    }
})
$stop.Add_Click({
    foreach ($p in $script:children) { try { if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } } catch {} }
    $script:children = @()
    $status.Text = 'Radar zatrzymany.'
})
$form.Add_FormClosing({
    foreach ($p in $script:children) { try { if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } } catch {} }
})
[void]$form.ShowDialog()
