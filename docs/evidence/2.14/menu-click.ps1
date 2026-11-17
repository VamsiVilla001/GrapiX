param([int]$ProcessId, [string]$Item)
# Choose a menu item of a real window's native menu bar the way Windows does when a person clicks it:
# read the menu (GetMenu, GetSubMenu, GetMenuString), find the item by its text, post WM_COMMAND with its id.
Add-Type -Namespace W -Name N -MemberDefinition @'
[DllImport("user32.dll")] public static extern System.IntPtr GetMenu(System.IntPtr h);
[DllImport("user32.dll")] public static extern System.IntPtr GetSubMenu(System.IntPtr m, int pos);
[DllImport("user32.dll")] public static extern int GetMenuItemCount(System.IntPtr m);
[DllImport("user32.dll")] public static extern uint GetMenuItemID(System.IntPtr m, int pos);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetMenuStringW(System.IntPtr m, uint pos, System.Text.StringBuilder s, int max, uint flags);
[DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr h, uint msg, System.IntPtr w, System.IntPtr l);
'@
$p = Get-Process -Id $ProcessId -ErrorAction Stop
$deadline = (Get-Date).AddSeconds(40)
$hwnd = [System.IntPtr]::Zero; $menu = [System.IntPtr]::Zero
while ((Get-Date) -lt $deadline) {
  $p.Refresh()
  $hwnd = $p.MainWindowHandle
  if ($hwnd -ne [System.IntPtr]::Zero) { $menu = [W.N]::GetMenu($hwnd); if ($menu -ne [System.IntPtr]::Zero) { break } }
  Start-Sleep -Milliseconds 300
}
if ($menu -eq [System.IntPtr]::Zero) { Write-Output "the window has no menu"; exit 3 }
$seen = @()
for ($i = 0; $i -lt [W.N]::GetMenuItemCount($menu); $i++) {
  $sb = New-Object System.Text.StringBuilder 256
  [void][W.N]::GetMenuStringW($menu, [uint32]$i, $sb, 256, 0x400)
  $top = $sb.ToString()
  $sub = [W.N]::GetSubMenu($menu, $i)
  if ($sub -eq [System.IntPtr]::Zero) { continue }
  for ($j = 0; $j -lt [W.N]::GetMenuItemCount($sub); $j++) {
    $sb2 = New-Object System.Text.StringBuilder 256
    [void][W.N]::GetMenuStringW($sub, [uint32]$j, $sb2, 256, 0x400)
    $text = $sb2.ToString()
    $seen += "$top > $text"
    if ($text -eq $Item) {
      $id = [W.N]::GetMenuItemID($sub, $j)
      Write-Output "menu: $($seen -join ' | ')"
      Write-Output "choosing '$top > $text' (id $id)"
      [void][W.N]::PostMessage($hwnd, 0x0111, [System.IntPtr]([int]$id), [System.IntPtr]::Zero)
      exit 0
    }
  }
}
Write-Output "no item '$Item' in: $($seen -join ' | ')"
exit 4
