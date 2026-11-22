---
title: 小米 WR30U 换官方 OpenWrt：从判断 U-Boot 是谁的，到 sysupgrade 一把过
published: 2026-11-22 16:10:00
description: 家里 WR30U 刷的是 hanwckf 不死 U-Boot（112M + NMBM 布局）。这次把它换成官方 OpenWrt 23.05.0：两套布局的 DTS 实测对比、怎么判断引导到底是哪套、UBI 结构校验踩到的 CRC 坑，以及 Wi-Fi「未关联」的真正原因。
tags: [OpenWrt, 路由器, 刷机, NMBM, 折腾]
category: 折腾
draft: false
pinned: false
---

家里这台小米 WR30U 是 MT7981B + 128 MB SPI-NAND 的机器，早先按论坛教程刷了 hanwckf 的「不死 U-Boot」，闪存被改成 112 MB 的 UBI 大分区，上面跑的是 ImmortalWrt 的 snapshot。

一直想换成官方 OpenWrt。真正动手前先踩了一轮认知坑：**中文圈说的「ubootmod 布局」和「112M 大分区」，到底是不是两套分区表？** 如果搞错，轻则刷完起不来，重则要拆机上 UART。这篇把判断过程、实测数据和最后的刷机过程记下来。

## 先搞清楚：我到底在哪个布局上

手上的引导是 `mt7981_wr30u-fip-fixed-parts-multi-layout.bin`，官方线那边对应的是 `xiaomi_mi-router-wr30u-ubootmod` 这个设备。两者名字完全不同，看起来像两套互不兼容的布局，网上也普遍这么说。

但把两边的 DTS 拉下来对比后，结论和传言不一样：

```dts
// hanwckf: mt7981-xiaomi-mi-router-wr30u-112m.dts
partition@600000 {
    label = "ubi";
    reg = <0x600000 0x7000000>;   // 0x600000 起，112 MiB
};

// OpenWrt: mt7981b-xiaomi-mi-router-wr30u-ubootmod.dts
&partitions {
    partition@600000 {
        label = "ubi";
        reg = <0x600000 0x7000000>;   // 一模一样
    };
};
```

**分区落点是同一个。** 差的不是分区表，而是：

| 差异点 | hanwckf 112M | 官方 ubootmod |
| --- | --- | --- |
| 板级 `compatible` | `xiaomi,mi-router-wr30u-112m` | `xiaomi,mi-router-wr30u-ubootmod` |
| 下层 U-Boot | `bl-mt798x` 的 multi-layout fip | `bl31-uboot.fip` + `preloader.bin` |
| 恢复入口 | `…-112m-squashfs-factory.bin` | `…-ubootmod-initramfs-factory.ubi` |

顺带一个安全点：`ubi` 分区从 `0x600000` 开始，U-Boot 本体在它前面。所以**刷任何 ubi 镜像都碰不到引导**，就算刷错也只是起不来，还能回 U-Boot 重刷。

## 怎么判断 U-Boot 是谁的

这是最容易搞错的一步：官方线和 hanwckf 线的恢复方式完全不同，方法用错会白折腾。

我把官方 `bl31-uboot.fip` 里的字符串全抽了一遍，发现它**根本没有网页界面**——`<html`、`httpd`、`upload`、`multipart` 的出现次数全是 0，只有 43 处 `bootmenu`、6 处 `tftpboot`。也就是说官方 U-Boot 的恢复是「串口菜单 + TFTP」，没有网页。

于是判据变得很简单：

| 判据 | hanwckf | 官方 |
| --- | --- | --- |
| 浏览器开 `192.168.1.1` | 有上传固件的网页（还有 `/uboot.html`） | 打不开网页 |
| 串口横幅 | 自定义版本号 | `U-Boot 2023.07.02-OpenWrt-r23497-6637af95aa` |
| `fw_printenv bootcmd` | 自定义（我这里是 `bootxq`） | `if pstore check ; then run boot_recovery ; else run boot_ubi ; fi` |
| `ubinfo -a` | 卷 0/1 是 `kernel`/`rootfs` | 先有 `ubootenv`/`ubootenv2` 两个 1 MiB 卷 |
| `/etc/fw_env.config` | 指向 mtd 分区 | 指向 `/dev/ubi0_0` |

我这台属于第一列：`/etc/fw_env.config` 是 `/dev/mtd1 0x0 0x10000 0x20000`，`fw_printenv bootcmd` 返回 `bootxq`，没有 `ubootenv` 卷。

## 为什么不自己编一个

本来打算从 hanwckf 的 `immortalwrt-mt798x` 编一个 `factory.bin`，环境一查就放弃了：

- 本机是 Windows，没有 WSL/Docker，OpenWrt 在 Windows 上编不了；
- 手上那台服务器只有 2 核、1.6 GB 内存、18 GB 可用盘，编 21.02 要 4–8 小时还容易 OOM；
- 更关键的是，官方 23.05.0 里**正好有匹配这套 112M+NMBM 布局的设备**（`xiaomi_mi-router-wr30u-112m-nmbm`），没必要自己造。

顺带记一下：24.10 已经把这个 `-112m-nmbm` 设备删掉了，所以留在 NMBM 布局上的话，23.05.0 是最后一个官方版本。

## 校验镜像：从 sha256 到 UBI 结构

下载完先对官方 `sha256sums`：

```text
6cd035b81b589d72393ff824b35f36d90dc4b41a365272ba0977ba80e499fd58  *…-112m-nmbm-squashfs-sysupgrade.bin
8192338 字节
```

文件不大（8 MB），但我想顺手确认它真的是个结构完整的 UBI 容器，就写了个解析脚本：遍历每个 PEB，检查 `UBI#` EC 头、`UBI!` VID 头、头 CRC、卷表，并区分「free PEB」。第一版跑出来直接报 5 个 PEB 损坏，结果发现**是我的脚本错了三处**：

1. CRC 用错了变体。UBI 用的是反射型 `crc32_le`（多项式 `0xEDB88320`、初值 `0xFFFFFFFF`、末尾不取反），我用成了非反射的 `0x04C11DB7`，所有头都算不对；
2. `vol_type` 映射反了：`1 = dynamic`、`2 = static`，我按 1 static 处理；
3. 布局卷 ID 不是 `0x7FF`，而是 `0x7FFFEFFF`（`0x7FFFFFFF - 4096`）。而且 ubinize 补出来的 PEB 只有 EC 头、VID 区还是 `0xFF`，那是正常的 free PEB，不该当损坏。

修完的输出：

```text
PEB 总数  : 65（free 5，异常 0）
image_seq : [1696887935]
data_offset: [4096]
数据卷    : 1
  - vol_id=0 kernel type=dynamic PEB=58 lnum=0..57
结论: UBI 结构完整（头 CRC 全部通过）
```

只有 `kernel` 卷、没有 `rootfs`——这是 `initramfs-factory.ubi` 的正常形态，它只是「进恢复系统」用的第一跳。

## 开刷

刷之前先做兼容性测试（只校验、不写盘）：

```sh
sysupgrade -T /tmp/openwrt-23.05.0-…-112m-nmbm-squashfs-sysupgrade.bin
# TEST_EXIT=0
```

板级名匹配，测试通过。然后清配置刷写：

```sh
sysupgrade -n /tmp/openwrt-23.05.0-…-112m-nmbm-squashfs-sysupgrade.bin
```

一个细节：busybox 里没有 `nohup`，想让刷写脱离 SSH 会话跑是行不通的。直接在 SSH 会话里跑就行，`sysupgrade` 会自己接管，连接在重启时自然断开。从执行到新系统 SSH 可用，大概 40 秒。

刷完：

```text
DISTRIB_DESCRIPTION='OpenWrt 23.05.0 r23497-6637af95aa'
board: xiaomi,mi-router-wr30u-112m-nmbm
```

## 刷完才发现的老问题：Wi-Fi「未关联」

在旧 ImmortalWrt 上，无线页面一直显示「未关联」。我原以为是信号或者驱动问题，结果 `iw dev` 一个无线接口都列不出来，日志里反复出现：

```text
radio0: Interface 0 setup failed: INVALID_WPA_PSK
```

翻 `uci show wireless` 才看到原因：两个 `wifi-iface` 都写了 `encryption='psk-mixed'`，但**没有 `key`**。hostapd 拿不到 PSK，直接不创建 AP 接口——所以不是连不上，是根本没在广播。

重配时还顺手绕了一个坑：5G 放在 36 信道，在 CN 区属于 DFS，hostapd 会卡在雷达检测：

```text
phy1-ap0: interface state HT_SCAN->DFS
```

DFS 要等 60 秒以上才启用。改成非 DFS 的 149 之后就秒起：

```text
phy1-ap0: interface state HT_SCAN->ENABLED
phy1-ap0: AP-ENABLED
```

## 现在的状态

| 项 | 值 |
| --- | --- |
| 固件 | OpenWrt 23.05.0 r23497-6637af95aa |
| 布局 | 112M UBI + NMBM（U-Boot 没动） |
| 2.4G | `ZuoQi` / ch1 / HE20 |
| 5G | `ZuoQi_5G` / ch149 / 80MHz |
| WAN | DHCP，正常 |
| 存储 | overlay 约 84 MB 可用 |

## 几条经验

- **布局名不一样，不等于分区表不一样。** 判断依据应该是 DTS 里的 `reg`，不是社区叫法。这次两套布局的 `ubi` 完全重合，省掉了一次换引导的高风险操作。
- **判断引导是谁的，最快的办法是看它有没有网页界面。** 官方 U-Boot 只有串口 + TFTP，能开网页刷固件的基本都是自定义 U-Boot。
- **`sysupgrade -T` 值得每次都跑。** 它只校验不写盘，能把板级名不匹配这类问题挡在刷写之前。
- **`iw dev` 为空 + `INVALID_WPA_PSK` 是一个明确的组合信号**：配置里缺 PSK，别往信号强度上想。
- **DFS 信道会拖慢 5G 上线**。家里用的话，能选 149 就别选 36。
- **U-Boot 在 `ubi` 分区之前**，所以只要不动引导，怎么刷都能救回来——这也是我敢直接 `sysupgrade -n` 清配置的底气。
