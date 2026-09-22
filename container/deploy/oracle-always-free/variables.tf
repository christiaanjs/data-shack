variable "tenancy_ocid" {
  description = "OCID of your OCI tenancy."
  type        = string
}

variable "user_ocid" {
  description = "OCID of the OCI user Terraform authenticates as."
  type        = string
}

variable "fingerprint" {
  description = "Fingerprint of the API signing key uploaded for the user above."
  type        = string
}

variable "private_key_path" {
  description = "Path to the PEM private key matching the uploaded API signing key."
  type        = string
}

variable "region" {
  description = "OCI region, e.g. us-ashburn-1. Always Free Ampere capacity varies by region."
  type        = string
}

variable "compartment_ocid" {
  description = "Compartment to create resources in (defaults to the tenancy root compartment)."
  type        = string
}

variable "ssh_public_key_path" {
  description = "Path to an SSH public key for the opc/ubuntu user."
  type        = string
  default     = "~/.ssh/id_rsa.pub"
}

variable "ssh_ingress_cidr" {
  description = "CIDR allowed to reach the instance on port 22. Narrow this to your own IP/32."
  type        = string
}

variable "instance_ocpus" {
  description = "OCPUs for the VM.Standard.A1.Flex instance. Always Free covers up to 4 total across all A1 instances."
  type        = number
  default     = 2
}

variable "instance_memory_gbs" {
  description = "Memory (GB) for the instance. Always Free covers up to 24 GB total across all A1 instances."
  type        = number
  default     = 12
}

variable "boot_volume_size_gbs" {
  description = "Boot volume size in GB. Always Free covers up to 200 GB total block storage."
  type        = number
  default     = 50
}

variable "repo_url" {
  description = "Git URL to clone (must contain the container/ directory this Dockerfile lives in)."
  type        = string
  default     = "https://github.com/christiaanjs/data-shack.git"
}

variable "git_ref" {
  description = "Branch or tag to deploy."
  type        = string
  default     = "main"
}

variable "worker_url" {
  description = "Base URL of the data-shack Worker, e.g. https://data-shack.example.workers.dev"
  type        = string
}

variable "auth_mode" {
  description = "\"dev-token\" or \"oauth-refresh\" — see ../../README.md."
  type        = string
  default     = "dev-token"
}

variable "dev_token" {
  description = "Shared secret matching the Worker's DEV_TOKEN, when auth_mode = dev-token."
  type        = string
  default     = ""
  sensitive   = true
}

variable "enable_catalog_views" {
  description = "Whether the client should register DuckDB views per catalog table."
  type        = bool
  default     = true
}

variable "log_level" {
  type    = string
  default = "info"
}
