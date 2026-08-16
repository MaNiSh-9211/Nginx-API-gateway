#include <linux/bpf.h>
#include <linux/in.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <bpf/bpf_helpers.h>

// BPF map to store blocked IPs
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __type(key, __u32);
    __type(value, __u32);
    __uint(max_entries, 100000);
} blocked_ips SEC(".maps");

SEC("xdp")
int xdp_drop_blocked_ips(struct xdp_md *ctx) {
    void *data_end = (void *)(long)ctx->data_end;
    void *data = (void *)(long)ctx->data;

    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return XDP_PASS;

    if (eth->h_proto != __constant_htons(ETH_P_IP))
        return XDP_PASS;

    struct iphdr *ip = (void *)(eth + 1);
    if ((void *)(ip + 1) > data_end)
        return XDP_PASS;

    __u32 src_ip = ip->saddr;

    // Lookup IP in blocked map
    __u32 *is_blocked = bpf_map_lookup_elem(&blocked_ips, &src_ip);
    if (is_blocked && *is_blocked == 1) {
        // Drop packet at the Network Interface Card (NIC) level!
        // This costs 0 CPU cycles for NGINX/Rust!
        return XDP_DROP;
    }

    return XDP_PASS;
}

char _license[] SEC("license") = "GPL";
