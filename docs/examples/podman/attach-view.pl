use strict;
use warnings;
use Fcntl qw(O_RDONLY O_DIRECTORY);
use POSIX qw(uname);

# Linux x86-64 syscall numbers. Clone the FUSE mount from the daemon's mount
# namespace, then attach it at the same path in this Pi process's private view.
use constant {
    SYS_SETNS => 308, SYS_OPEN_TREE => 428, SYS_MOVE_MOUNT => 429,
    O_PATH => 010000000, O_CLOEXEC => 02000000,
    AT_EMPTY_PATH => 0x1000, AT_FDCWD => -100,
    OPEN_TREE_CLONE => 1, MOVE_MOUNT_F_EMPTY_PATH => 4,
};

my ($pid, $path, $device, $inode, $start_ticks) = @ARGV;
die "Invalid Workspace mount request\n" unless (uname())[4] eq 'x86_64'
    && $> == 0 && $pid =~ /^[1-9][0-9]*$/
    && $path =~ m{\A/persist/layerfs/machine/native/run/[a-z0-9_.-]+/workspaces/[0-9]+\z};

sub start_ticks {
    open my $proc_stat, '<', "/proc/$pid/stat" or die "Read daemon identity: $!\n";
    my $status = <$proc_stat>;
    $status =~ s/.*\) // or die "Parse daemon identity\n";
    return (split /\s+/, $status)[19];
}

my $own_namespace = readlink '/proc/self/ns/mnt';
die "Pi mount namespace must be private\n" if $own_namespace eq readlink '/proc/1/ns/mnt';
open my $mounts, '<', '/proc/self/mountinfo' or die "Read mount propagation: $!\n";
while (<$mounts>) {
    die "Pi mount namespace has shared propagation\n" if / (?:shared|master|propagate_from):/;
}
die "Daemon identity changed\n" unless start_ticks() eq $start_ticks;
open my $own, '<', '/proc/self/ns/mnt' or die "Open Pi namespace: $!\n";
open my $daemon, '<', "/proc/$pid/ns/mnt" or die "Open daemon namespace: $!\n";
sysopen my $source, "/proc/$pid/root$path", O_PATH | O_DIRECTORY | O_CLOEXEC
    or die "Open daemon Workspace: $!\n";
my @source = stat $source;
die "Workspace identity changed\n" unless @source && $source[0] eq $device && $source[1] eq $inode;

syscall(SYS_SETNS, fileno($daemon), 0) == 0 or die "Enter daemon namespace: $!\n";
my $empty = '';
my $mount = syscall(SYS_OPEN_TREE, fileno($source), $empty, AT_EMPTY_PATH | OPEN_TREE_CLONE | O_CLOEXEC);
my $clone_error = "$!";
syscall(SYS_SETNS, fileno($own), 0) == 0 or die "Restore Pi namespace: $!\n";
die "Clone Workspace mount: $clone_error\n" if $mount < 0;
die "Pi or daemon namespace identity changed\n" unless readlink('/proc/self/ns/mnt') eq $own_namespace
    && start_ticks() eq $start_ticks && readlink("/proc/$pid/ns/mnt") eq 'mnt:[' . (stat $daemon)[1] . ']';
syscall(SYS_MOVE_MOUNT, $mount, $empty, AT_FDCWD, $path, MOVE_MOUNT_F_EMPTY_PATH) == 0
    or die "Attach Workspace mount: $!\n";
my @target = stat $path;
die "Attached mount identity differs\n" unless @target && $target[0] eq $device && $target[1] eq $inode;
