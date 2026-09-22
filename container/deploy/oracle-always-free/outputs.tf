output "instance_public_ip" {
  description = "Public IP of the session-client VM. SSH in as ubuntu@<this>."
  value       = oci_core_instance.session_client.public_ip
}

output "ssh_command" {
  value = "ssh ubuntu@${oci_core_instance.session_client.public_ip}"
}

output "scp_credentials_command" {
  description = "For AUTH_MODE=oauth-refresh: copy the credential file produced by `npm run login`, then restart the service."
  value       = "scp ./credentials.json ubuntu@${oci_core_instance.session_client.public_ip}:/tmp/credentials.json && ssh ubuntu@${oci_core_instance.session_client.public_ip} 'sudo mv /tmp/credentials.json /opt/data-shack/data/credentials.json && sudo chmod 600 /opt/data-shack/data/credentials.json && sudo systemctl restart data-shack-session'"
}
