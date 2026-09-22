terraform {
  required_version = ">= 1.5"
  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 6.0"
    }
  }
}

provider "oci" {
  tenancy_ocid     = var.tenancy_ocid
  user_ocid        = var.user_ocid
  fingerprint      = var.fingerprint
  private_key_path = var.private_key_path
  region           = var.region
}

data "oci_identity_availability_domains" "ads" {
  compartment_id = var.tenancy_ocid
}

# Always Free Ampere capacity is scarcest on AD 1 in some regions — picking
# the last AD spreads new deployments across ADs a little.
locals {
  availability_domain = element(
    data.oci_identity_availability_domains.ads.availability_domains,
    length(data.oci_identity_availability_domains.ads.availability_domains) - 1,
  ).name
}

data "oci_core_images" "ubuntu" {
  compartment_id           = var.compartment_ocid
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "22.04"
  shape                    = "VM.Standard.A1.Flex"
  sort_by                  = "TIMECREATED"
  sort_order                = "DESC"
}

resource "oci_core_vcn" "this" {
  compartment_id = var.compartment_ocid
  display_name   = "data-shack-session-vcn"
  cidr_blocks    = ["10.20.0.0/16"]
  dns_label      = "dshacksess"
}

resource "oci_core_internet_gateway" "this" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.this.id
  display_name   = "data-shack-session-igw"
  enabled        = true
}

resource "oci_core_route_table" "this" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.this.id
  display_name   = "data-shack-session-rt"

  route_rules {
    destination       = "0.0.0.0/0"
    network_entity_id = oci_core_internet_gateway.this.id
  }
}

resource "oci_core_security_list" "this" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.this.id
  display_name   = "data-shack-session-seclist"

  # Outbound-only workload: no inbound ports needed for the app itself.
  egress_security_rules {
    destination = "0.0.0.0/0"
    protocol    = "all"
  }

  ingress_security_rules {
    source   = var.ssh_ingress_cidr
    protocol = "6" # TCP
    tcp_options {
      min = 22
      max = 22
    }
  }
}

resource "oci_core_subnet" "this" {
  compartment_id             = var.compartment_ocid
  vcn_id                     = oci_core_vcn.this.id
  cidr_block                 = "10.20.0.0/24"
  display_name               = "data-shack-session-subnet"
  dns_label                  = "sessionsub"
  route_table_id             = oci_core_route_table.this.id
  security_list_ids          = [oci_core_security_list.this.id]
  prohibit_public_ip_on_vnic = false
}

resource "oci_core_instance" "session_client" {
  compartment_id      = var.compartment_ocid
  availability_domain = local.availability_domain
  display_name        = "data-shack-session-client"
  shape                = "VM.Standard.A1.Flex"

  shape_config {
    ocpus         = var.instance_ocpus
    memory_in_gbs = var.instance_memory_gbs
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.this.id
    assign_public_ip = true
  }

  source_details {
    source_type             = "image"
    source_id               = data.oci_core_images.ubuntu.images[0].id
    boot_volume_size_in_gbs = var.boot_volume_size_gbs
  }

  metadata = {
    ssh_authorized_keys = file(var.ssh_public_key_path)
    user_data = base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", {
      repo_url             = var.repo_url
      git_ref              = var.git_ref
      worker_url           = var.worker_url
      auth_mode             = var.auth_mode
      dev_token             = var.dev_token
      enable_catalog_views  = var.enable_catalog_views
      log_level             = var.log_level
    }))
  }
}
