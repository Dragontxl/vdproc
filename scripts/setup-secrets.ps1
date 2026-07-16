param(
    [Parameter(Mandatory=$true)]
    [string]$GitHubToken,
    
    [Parameter(Mandatory=$true)]
    [string]$RepoName,
    
    [Parameter(Mandatory=$true)]
    [string]$R2AccessKeyId,
    
    [Parameter(Mandatory=$true)]
    [string]$R2SecretAccessKey,
    
    [Parameter(Mandatory=$true)]
    [string]$R2EndpointUrl,
    
    [Parameter(Mandatory=$true)]
    [string]$R2BucketName,
    
    [Parameter(Mandatory=$true)]
    [string]$CallbackUrl,
    
    [Parameter(Mandatory=$true)]
    [string]$CallbackSecret,
    
    [Parameter(Mandatory=$true)]
    [string]$BackendApiKey,
    
    [Parameter(Mandatory=$false)]
    [string]$AiApiKey = "",
    
    [Parameter(Mandatory=$false)]
    [string]$AiBaseUrl = ""
)

$ErrorActionPreference = "Stop"

function Get-PublicKey {
    param($owner, $repo, $token)
    
    $headers = @{
        "Authorization" = "token $token"
        "Accept" = "application/vnd.github.v3+json"
    }
    
    $url = "https://api.github.com/repos/$owner/$repo/actions/secrets/public-key"
    try {
        $response = Invoke-RestMethod -Uri $url -Headers $headers -Method Get
        return $response
    } catch {
        Write-Error "Failed to get public key for $owner/$repo : $_"
        return $null
    }
}

function Set-Secret {
    param($owner, $repo, $token, $keyName, $value)
    
    $pubKey = Get-PublicKey -owner $owner -repo $repo -token $token
    if (-not $pubKey) {
        Write-Warning "Skipping $keyName for $owner/$repo"
        return
    }
    
    $keyId = $pubKey.key_id
    $key = $pubKey.key
    
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($value)
    
    $rsa = New-Object System.Security.Cryptography.RSACryptoServiceProvider
    $rsa.FromXmlString([System.Security.Cryptography.Xml.RSAKeyValue]::LoadXml($key).ToString())
    
    $encrypted = $rsa.Encrypt($bytes, $true)
    $encryptedBase64 = [System.Convert]::ToBase64String($encrypted)
    
    $headers = @{
        "Authorization" = "token $token"
        "Accept" = "application/vnd.github.v3+json"
    }
    
    $body = @{
        encrypted_value = $encryptedBase64
        key_id = $keyId
    } | ConvertTo-Json
    
    $url = "https://api.github.com/repos/$owner/$repo/actions/secrets/$keyName"
    try {
        $response = Invoke-RestMethod -Uri $url -Headers $headers -Method Put -Body $body -ContentType "application/json"
        Write-Host "✓ Set $keyName for $owner/$repo"
    } catch {
        Write-Error "Failed to set $keyName for $owner/$repo : $_"
    }
}

$owners = @(
    "Dragontxl"
)

$secrets = @(
    @{ name = "R2_ACCESS_KEY_ID"; value = $R2AccessKeyId }
    @{ name = "R2_SECRET_ACCESS_KEY"; value = $R2SecretAccessKey }
    @{ name = "R2_ENDPOINT_URL"; value = $R2EndpointUrl }
    @{ name = "R2_BUCKET_NAME"; value = $R2BucketName }
    @{ name = "CALLBACK_URL"; value = $CallbackUrl }
    @{ name = "CALLBACK_SECRET"; value = $CallbackSecret }
    @{ name = "BACKEND_API_KEY"; value = $BackendApiKey }
)

if ($AiApiKey) {
    $secrets += @{ name = "AI_API_KEY"; value = $AiApiKey }
}
if ($AiBaseUrl) {
    $secrets += @{ name = "AI_BASE_URL"; value = $AiBaseUrl }
}

Write-Host "========================================"
Write-Host "  GitHub Secrets Setup Script"
Write-Host "========================================"
Write-Host "Repo Name: $RepoName"
Write-Host "Total Owners: $($owners.Count)"
Write-Host "Total Secrets: $($secrets.Count)"
Write-Host ""

foreach ($owner in $owners) {
    Write-Host "Setting secrets for $owner/$RepoName..."
    
    foreach ($secret in $secrets) {
        Set-Secret -owner $owner -repo $RepoName -token $GitHubToken -keyName $secret.name -value $secret.value
    }
    
    Write-Host ""
}

Write-Host "========================================"
Write-Host "  Done!"
Write-Host "========================================"