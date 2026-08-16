// ============================================================
// XDP DDoS Filter — Ultra-Scale API Gateway L4 Protection
//
// Runs in the Linux kernel at the NIC driver level (XDP_DRV mode).
// Packets are inspected and dropped BEFORE they reach the TCP stack.
// This means malicious traffic never consumes CPU in NGINX or Rust.
//
// What this filters:
//   1. SYN flood: tracks SYN rate per source IP using a BPF LRU map.
//      If a single IP sends > SYN_RATE_LIMIT SYNs/s → XDP_DROP.
//   2. Connection rate: total new connections/s per IP.
//      If > CONN_RATE_LIMIT → XDP_DROP.
//   3. Allowlist: known good IPs (CDN edge nodes, health checkers) bypass all checks.
//
// Compile:
//   clang -O2 -target bpf -c xdp_ddos_filter.c -o xdp_ddos_filter.o
//
// Load (replace eth0 with your NIC):
//   ip link set dev eth0 xdp obj xdp_ddos_filter.o sec xdp_ddos
//
// Unload:
//   ip link set dev eth0 xdp off
//
// Monitor blocked IPs:
//   bpftool map dump name blocked_ips
// ============================================================

#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/tcp.h>
#include <linux/udp.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

// ── Tunable limits ────────────────────────────────────────────
#define SYN_RATE_LIMIT   1000   // max SYN packets/s per source IP
#define CONN_RATE_LIMIT  5000   // max new connections/s per source IP
#define MAP_MAX_ENTRIES  65536  // max tracked IPs

// ── BPF maps ──────────────────────────────────────────────────

// Tracks SYN count per source IP in the current second
struct {
    __uint(type,        BPF_MAP_TYPE_LRU_HASH);
    __uint(max_entries, MAP_MAX_ENTRIES);
    __type(key,   __u32);  // source IPv4
    __type(value, __u64);  // packed: (timestamp_32 << 32) | count_32
} syn_counters SEC(".maps");

// Tracks total connection rate per source IP
struct {
    __uint(type,        BPF_MAP_TYPE_LRU_HASH);
    __uint(max_entries, MAP_MAX_ENTRIES);
    __type(key,   __u32);
    __type(value, __u64);
} conn_counters SEC(".maps");

// Permanently blocked IPs (set by userspace control plane)
struct {
    __uint(type,        BPF_MAP_TYPE_HASH);
    __uint(max_entries, MAP_MAX_ENTRIES);
    __type(key,   __u32);
    __type(value, __u8);
} blocked_ips SEC(".maps");

// Allowlisted IPs — always pass (CDN edge nodes, health checkers)
struct {
    __uint(type,        BPF_MAP_TYPE_HASH);
    __uint(max_entries, 1024);
    __type(key,   __u32);
    __type(value, __u8);
} allowlist SEC(".maps");

// ── Rate check helper ─────────────────────────────────────────

static __always_inline int rate_exceeded(
    void *map, __u32 src_ip, __u32 limit, __u64 now_sec
) {
    __u64 *val = bpf_map_lookup_elem(map, &src_ip);
    __u64 new_val;

    if (!val) {
        new_val = (now_sec << 32) | 1;
        bpf_map_update_elem(map, &src_ip, &new_val, BPF_ANY);
        return 0;
    }

    __u32 stored_sec = ((__u32)(*val >> 32));
    __u32 count      = ((__u32)(*val & 0xFFFFFFFF));

    if (stored_sec != (__u32)now_sec) {
        // New second — reset counter
        new_val = (now_sec << 32) | 1;
        bpf_map_update_elem(map, &src_ip, &new_val, BPF_ANY);
        return 0;
    }

    if (count >= limit) {
        return 1; // rate exceeded
    }

    new_val = (now_sec << 32) | (count + 1);
    bpf_map_update_elem(map, &src_ip, &new_val, BPF_ANY);
    return 0;
}

// ── XDP program ───────────────────────────────────────────────

SEC("xdp_ddos")
int xdp_ddos_filter(struct xdp_md *ctx) {
    void *data     = (void *)(long)ctx->data;
    void *data_end = (void *)(long)ctx->data_end;

    // Parse Ethernet header
    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return XDP_PASS;
    if (eth->h_proto != bpf_htons(ETH_P_IP))
        return XDP_PASS;

    // Parse IP header
    struct iphdr *ip = (void *)(eth + 1);
    if ((void *)(ip + 1) > data_end)
        return XDP_PASS;

    __u32 src_ip = ip->saddr;

    // Always pass allowlisted IPs
    if (bpf_map_lookup_elem(&allowlist, &src_ip))
        return XDP_PASS;

    // Drop permanently blocked IPs
    if (bpf_map_lookup_elem(&blocked_ips, &src_ip))
        return XDP_DROP;

    // Only inspect TCP
    if (ip->protocol != IPPROTO_TCP)
        return XDP_PASS;

    struct tcphdr *tcp = (void *)ip + (ip->ihl * 4);
    if ((void *)(tcp + 1) > data_end)
        return XDP_PASS;

    __u64 now_sec = bpf_ktime_get_ns() / 1000000000ULL;

    // SYN flood detection
    if (tcp->syn && !tcp->ack) {
        if (rate_exceeded(&syn_counters, src_ip, SYN_RATE_LIMIT, now_sec))
            return XDP_DROP;
    }

    // Connection rate limiting
    if (rate_exceeded(&conn_counters, src_ip, CONN_RATE_LIMIT, now_sec))
        return XDP_DROP;

    return XDP_PASS;
}

char _license[] SEC("license") = "GPL";
